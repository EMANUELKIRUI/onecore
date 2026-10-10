import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  branches,
  denyAllAuthorizationService,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationService,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
} from "@onecore/database";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() }).strict();
const branchPathSchema = organizationPathSchema
  .extend({ branchId: z.uuid() })
  .strict();
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const branchCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .transform((code) => code.toUpperCase());
const createBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: branchCodeSchema,
  })
  .strict();
const updateBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    code: branchCodeSchema.optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

const branchReadPermission = "core.organization.branch.read";
const branchCreatePermission = "core.organization.branch.create";
const branchUpdatePermission = "core.organization.branch.update";

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: {
  auth: AuthorizationContext | null;
}): AuthorizationContext | null {
  return request.auth;
}

function response(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    body: { error: { code, message } },
  };
}

function notFound(): OperationResponse {
  return response(404, "NOT_FOUND", "The requested resource was not found.");
}

function forbidden(): OperationResponse {
  return response(403, "FORBIDDEN", "The request is not authorized.");
}

function invalid(): OperationResponse {
  return response(400, "BAD_REQUEST", "The request could not be processed.");
}

function conflict(): OperationResponse {
  return response(409, "CONFLICT", "A branch with this code already exists.");
}

function send(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  result: OperationResponse,
) {
  return reply.status(result.statusCode).send(result.body);
}

async function logScopeDenial(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  permissionKey: string,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action: "authorization.permission.denied",
    resource: "permission",
    resourceId: permissionKey,
    result: "FAILURE",
    requestMetadata: {
      requestId,
      branchId: context.branchId,
      reason: "insufficient_scope",
      target: "organization_branch",
    },
  });
}

function hasOrganizationScope(
  context: ResolvedAuthorizationContext,
  permissionKey: string,
): boolean {
  return context.permissions.some(
    (permission) =>
      permission.key === permissionKey &&
      permission.scopeType === "ORGANIZATION",
  );
}

function uniqueBranchCodeConflict(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    cause?: unknown;
  };
  if (
    candidate.code === "23505" &&
    (candidate.constraint === "branches_organization_code_unique" ||
      candidate.constraint_name === "branches_organization_code_unique")
  ) {
    return true;
  }
  return candidate.cause !== undefined
    ? uniqueBranchCodeConflict(candidate.cause, depth + 1)
    : false;
}

export function registerBranchRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  const branchesPath = "/organizations/:organizationId/branches";

  app.get(branchesPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!path.success || !query.success) return send(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      branchReadPermission,
      { requestId: request.id },
      async (transaction, context) => {
        if (context.organizationId !== path.data.organizationId)
          return notFound();
        if (!hasOrganizationScope(context, branchReadPermission)) {
          await logScopeDenial(
            transaction,
            context,
            request.id,
            branchReadPermission,
          );
          return forbidden();
        }
        const rows = await transaction
          .select({
            id: branches.id,
            name: branches.name,
            code: branches.code,
            status: branches.status,
            createdAt: branches.createdAt,
            updatedAt: branches.updatedAt,
          })
          .from(branches)
          .where(eq(branches.organizationId, context.organizationId))
          .orderBy(asc(branches.name), asc(branches.id))
          .limit(query.data.limit + 1)
          .offset(query.data.offset);
        return {
          statusCode: 200,
          body: {
            branches: rows.slice(0, query.data.limit).map((branch) => ({
              ...branch,
              createdAt: branch.createdAt.toISOString(),
              updatedAt: branch.updatedAt.toISOString(),
            })),
            limit: query.data.limit,
            offset: query.data.offset,
            hasMore: rows.length > query.data.limit,
            capabilities: {
              canCreate: hasOrganizationScope(context, branchCreatePermission),
              canUpdate: hasOrganizationScope(context, branchUpdatePermission),
            },
          },
        };
      },
    );
    if (!result.allowed)
      return send(
        reply,
        response(
          result.statusCode,
          result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          result.statusCode === 401
            ? "Authentication is required."
            : "The request is not authorized.",
        ),
      );
    return send(reply, result.value);
  });

  app.post(branchesPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const body = createBranchSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        branchCreatePermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId)
            return notFound();
          if (!hasOrganizationScope(context, branchCreatePermission)) {
            await logScopeDenial(
              transaction,
              context,
              request.id,
              branchCreatePermission,
            );
            return forbidden();
          }
          const inserted = await transaction.execute(sql`
            INSERT INTO "branches" ("organization_id", "name", "code")
            VALUES (
              ${context.organizationId},
              ${body.data.name},
              ${body.data.code}
            )
            ON CONFLICT ("organization_id", "code") DO NOTHING
            RETURNING "id"
          `);
          const insertedId = inserted[0]?.id;
          if (insertedId === undefined) return conflict();
          const parsedId = z.uuid().safeParse(insertedId);
          if (!parsedId.success) {
            throw new Error("Created branch returned an invalid identifier");
          }
          const [branch] = await transaction
            .select({
              id: branches.id,
              name: branches.name,
              code: branches.code,
              status: branches.status,
              createdAt: branches.createdAt,
              updatedAt: branches.updatedAt,
            })
            .from(branches)
            .where(
              and(
                eq(branches.organizationId, context.organizationId),
                eq(branches.id, parsedId.data),
              ),
            )
            .limit(1);
          if (!branch) throw new Error("Created branch could not be read");
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "branch.created",
            "branch",
            branch.id,
            { changedFields: ["name", "code"] },
          );
          return {
            statusCode: 201,
            body: {
              branch: {
                ...branch,
                createdAt: branch.createdAt.toISOString(),
                updatedAt: branch.updatedAt.toISOString(),
              },
            },
          };
        },
      );
      if (!result.allowed)
        return send(
          reply,
          response(
            result.statusCode,
            result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            result.statusCode === 401
              ? "Authentication is required."
              : "The request is not authorized.",
          ),
        );
      return send(reply, result.value);
    } catch (error) {
      if (uniqueBranchCodeConflict(error)) return send(reply, conflict());
      throw error;
    }
  });

  app.patch<{ Params: { organizationId: string; branchId: string } }>(
    `${branchesPath}/:branchId`,
    async (request, reply) => {
      const path = branchPathSchema.safeParse(request.params);
      const body = updateBranchSchema.safeParse(request.body);
      if (!path.success || !body.success) return send(reply, invalid());
      try {
        const result = await authorization.withPermission(
          requestContext(request),
          branchUpdatePermission,
          { requestId: request.id },
          async (transaction, context) => {
            if (context.organizationId !== path.data.organizationId)
              return notFound();
            if (!hasOrganizationScope(context, branchUpdatePermission)) {
              await logScopeDenial(
                transaction,
                context,
                request.id,
                branchUpdatePermission,
              );
              return forbidden();
            }
            const [branch] = await transaction
              .update(branches)
              .set({ ...body.data, updatedAt: new Date() })
              .where(
                and(
                  eq(branches.organizationId, context.organizationId),
                  eq(branches.id, path.data.branchId),
                ),
              )
              .returning({
                id: branches.id,
                name: branches.name,
                code: branches.code,
                status: branches.status,
                createdAt: branches.createdAt,
                updatedAt: branches.updatedAt,
              });
            if (!branch) return notFound();
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              "branch.updated",
              "branch",
              branch.id,
              { changedFields: Object.keys(body.data), status: branch.status },
            );
            return {
              statusCode: 200,
              body: {
                branch: {
                  ...branch,
                  createdAt: branch.createdAt.toISOString(),
                  updatedAt: branch.updatedAt.toISOString(),
                },
              },
            };
          },
        );
        if (!result.allowed)
          return send(
            reply,
            response(
              result.statusCode,
              result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
              result.statusCode === 401
                ? "Authentication is required."
                : "The request is not authorized.",
            ),
          );
        return send(reply, result.value);
      } catch (error) {
        if (uniqueBranchCodeConflict(error)) return send(reply, conflict());
        throw error;
      }
    },
  );
}
