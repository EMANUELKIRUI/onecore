import { and, asc, count, eq } from "drizzle-orm";
import {
  auditLogs,
  branches,
  denyAllAuthorizationService,
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
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const addressSchema = z.string().trim().max(1_000).nullable().optional();
const createBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: z.string().trim().min(1).max(50).toUpperCase(),
    address: addressSchema,
  })
  .strict();
const updateBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    code: z.string().trim().min(1).max(50).toUpperCase().optional(),
    address: addressSchema,
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: {
  auth: AuthorizationContext | null;
}): AuthorizationContext | null {
  return request.auth;
}

function send(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  result: OperationResponse,
) {
  return reply.status(result.statusCode).send(result.body);
}

function response(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } };
}

function denied(statusCode: 401 | 403): OperationResponse {
  return response(
    statusCode,
    statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
    statusCode === 401
      ? "Authentication is required."
      : "The request is not authorized.",
  );
}

function organizationScope(
  context: ResolvedAuthorizationContext,
  permissionKey: string,
): boolean {
  return context.permissions.some(
    (permission) =>
      permission.key === permissionKey &&
      permission.scopeType === "ORGANIZATION",
  );
}

function branchAddressLabel(address: Record<string, unknown> | null): string {
  if (!address) return "";
  if (typeof address.formatted === "string") return address.formatted;
  return Object.values(address)
    .filter((value): value is string => typeof value === "string")
    .join(", ");
}

function branchView(branch: typeof branches.$inferSelect) {
  return {
    id: branch.id,
    organizationId: branch.organizationId,
    name: branch.name,
    code: branch.code,
    status: branch.status,
    address: branchAddressLabel(branch.address),
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
  };
}

function branchAddress(value: string | null | undefined) {
  return value ? { formatted: value } : {};
}

function isDuplicateCode(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    cause?: unknown;
  };
  const duplicate =
    candidate.code === "23505" &&
    (candidate.constraint === "branches_organization_code_unique" ||
      candidate.constraint_name === "branches_organization_code_unique");
  return (
    duplicate ||
    (candidate.cause !== undefined &&
      isDuplicateCode(candidate.cause, depth + 1))
  );
}

async function auditBranchMutation(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  branchId: string,
  action: "created" | "updated",
  changedFields: string[],
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action: `organization.branch.${action}`,
    resource: "branch",
    resourceId: branchId,
    result: "SUCCESS",
    requestMetadata: {
      requestId,
      branchId: context.branchId,
      changedFields,
    },
  });
}

function matchesOrganization(
  organizationId: string,
  context: ResolvedAuthorizationContext,
): boolean {
  return organizationId === context.organizationId;
}

export function registerBranchRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  const collectionPath = "/organizations/:organizationId/branches";
  const resourcePath = `${collectionPath}/:branchId`;

  app.get(collectionPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!path.success || !query.success) {
      return send(
        reply,
        response(400, "BAD_REQUEST", "The request could not be processed."),
      );
    }
    const result = await authorization.withPermission(
      requestContext(request),
      "core.organization.branch.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!matchesOrganization(path.data.organizationId, context)) {
          return response(
            404,
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        }
        if (!organizationScope(context, "core.organization.branch.read")) {
          return response(403, "FORBIDDEN", "The request is not authorized.");
        }
        const [items, [total]] = await Promise.all([
          transaction
            .select()
            .from(branches)
            .where(eq(branches.organizationId, context.organizationId))
            .orderBy(asc(branches.name), asc(branches.code))
            .limit(query.data.limit)
            .offset(query.data.offset),
          transaction
            .select({ value: count() })
            .from(branches)
            .where(eq(branches.organizationId, context.organizationId)),
        ]);
        return {
          statusCode: 200,
          body: {
            items: items.map(branchView),
            total: total?.value ?? 0,
            limit: query.data.limit,
            offset: query.data.offset,
            capabilities: {
              create: organizationScope(
                context,
                "core.organization.branch.create",
              ),
              update: organizationScope(
                context,
                "core.organization.branch.update",
              ),
            },
          },
        };
      },
    );
    if (!result.allowed) return send(reply, denied(result.statusCode));
    return send(reply, result.value);
  });

  app.post(collectionPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const body = createBranchSchema.safeParse(request.body);
    if (!path.success || !body.success) {
      return send(
        reply,
        response(400, "BAD_REQUEST", "The request could not be processed."),
      );
    }
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "core.organization.branch.create",
        { requestId: request.id },
        async (transaction, context) => {
          if (!matchesOrganization(path.data.organizationId, context)) {
            return response(
              404,
              "NOT_FOUND",
              "The requested resource was not found.",
            );
          }
          if (!organizationScope(context, "core.organization.branch.create")) {
            return response(403, "FORBIDDEN", "The request is not authorized.");
          }
          const [created] = await transaction
            .insert(branches)
            .values({
              organizationId: context.organizationId,
              name: body.data.name,
              code: body.data.code,
              address: branchAddress(body.data.address),
            })
            .returning();
          if (!created) {
            return response(403, "FORBIDDEN", "The request is not authorized.");
          }
          await auditBranchMutation(
            transaction,
            context,
            request.id,
            created.id,
            "created",
            Object.keys(body.data),
          );
          return { statusCode: 201, body: { branch: branchView(created) } };
        },
      );
      if (!result.allowed) return send(reply, denied(result.statusCode));
      return send(reply, result.value);
    } catch (error) {
      if (isDuplicateCode(error)) {
        return send(
          reply,
          response(409, "CONFLICT", "A branch with this code already exists."),
        );
      }
      throw error;
    }
  });

  app.patch(resourcePath, async (request, reply) => {
    const path = branchPathSchema.safeParse(request.params);
    const body = updateBranchSchema.safeParse(request.body);
    if (!path.success || !body.success) {
      return send(
        reply,
        response(400, "BAD_REQUEST", "The request could not be processed."),
      );
    }
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "core.organization.branch.update",
        { requestId: request.id },
        async (transaction, context) => {
          if (!matchesOrganization(path.data.organizationId, context)) {
            return response(
              404,
              "NOT_FOUND",
              "The requested resource was not found.",
            );
          }
          if (!organizationScope(context, "core.organization.branch.update")) {
            return response(403, "FORBIDDEN", "The request is not authorized.");
          }
          const [existing] = await transaction
            .select()
            .from(branches)
            .where(
              and(
                eq(branches.organizationId, context.organizationId),
                eq(branches.id, path.data.branchId),
              ),
            )
            .limit(1);
          if (!existing) {
            return response(
              404,
              "NOT_FOUND",
              "The requested resource was not found.",
            );
          }
          if (
            body.data.status &&
            !["ACTIVE", "INACTIVE"].includes(existing.status)
          ) {
            return response(
              409,
              "CONFLICT",
              "This branch lifecycle state cannot be changed here.",
            );
          }
          const values = {
            ...(body.data.name !== undefined ? { name: body.data.name } : {}),
            ...(body.data.code !== undefined ? { code: body.data.code } : {}),
            ...(body.data.address !== undefined
              ? { address: branchAddress(body.data.address) }
              : {}),
            ...(body.data.status !== undefined
              ? { status: body.data.status }
              : {}),
            updatedAt: new Date(),
          };
          const [updated] = await transaction
            .update(branches)
            .set(values)
            .where(
              and(
                eq(branches.organizationId, context.organizationId),
                eq(branches.id, path.data.branchId),
              ),
            )
            .returning();
          if (!updated) {
            return response(
              404,
              "NOT_FOUND",
              "The requested resource was not found.",
            );
          }
          await auditBranchMutation(
            transaction,
            context,
            request.id,
            updated.id,
            "updated",
            Object.keys(body.data),
          );
          return { statusCode: 200, body: { branch: branchView(updated) } };
        },
      );
      if (!result.allowed) return send(reply, denied(result.statusCode));
      return send(reply, result.value);
    } catch (error) {
      if (isDuplicateCode(error)) {
        return send(
          reply,
          response(409, "CONFLICT", "A branch with this code already exists."),
        );
      }
      throw error;
    }
  });
}
