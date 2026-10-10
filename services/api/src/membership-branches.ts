import { and, asc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  branches,
  denyAllAuthorizationService,
  membershipBranches,
  organizationMemberships,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationService,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
} from "@onecore/database";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() }).strict();
const membershipPathSchema = organizationPathSchema
  .extend({ membershipId: z.uuid() })
  .strict();
const assignmentPathSchema = membershipPathSchema
  .extend({ branchId: z.uuid() })
  .strict();
const branchIdsSchema = z
  .object({
    branchIds: z.array(z.uuid()).min(1).max(100),
  })
  .strict()
  .refine((value) => new Set(value.branchIds).size === value.branchIds.length);

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

function permissionDenied(statusCode: 401 | 403): OperationResponse {
  return response(
    statusCode,
    statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
    statusCode === 401
      ? "Authentication is required."
      : "The request is not authorized.",
  );
}

function hasOrganizationPermission(
  context: ResolvedAuthorizationContext,
  key: string,
): boolean {
  return context.permissions.some(
    (permission) =>
      permission.key === key && permission.scopeType === "ORGANIZATION",
  );
}

function matchesOrganization(
  organizationId: string,
  context: ResolvedAuthorizationContext,
): boolean {
  return organizationId === context.organizationId;
}

function badRequest() {
  return response(400, "BAD_REQUEST", "The request could not be processed.");
}

function notFound() {
  return response(404, "NOT_FOUND", "The requested resource was not found.");
}

function forbidden() {
  return response(403, "FORBIDDEN", "The request is not authorized.");
}

function allBranchesConflict() {
  return response(
    409,
    "CONFLICT",
    "Explicit branch assignments cannot be changed while branch access mode is ALL.",
  );
}

async function listAssignedBranches(
  transaction: OrganizationTransaction,
  organizationId: string,
  membershipId: string,
) {
  return transaction
    .select({
      branchId: branches.id,
      name: branches.name,
      code: branches.code,
      status: branches.status,
    })
    .from(membershipBranches)
    .innerJoin(
      branches,
      and(
        eq(branches.organizationId, membershipBranches.organizationId),
        eq(branches.id, membershipBranches.branchId),
      ),
    )
    .where(
      and(
        eq(membershipBranches.organizationId, organizationId),
        eq(membershipBranches.membershipId, membershipId),
      ),
    )
    .orderBy(asc(branches.name), asc(branches.code));
}

async function logSelfAssignmentDenial(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  membershipId: string,
  branchId: string | null,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action: "authorization.membership_branch.denied",
    resource: "membership_branch",
    resourceId: branchId ? `${membershipId}:${branchId}` : membershipId,
    result: "FAILURE",
    requestMetadata: {
      requestId,
      branchId: context.branchId,
      reason: "self_assignment_prevented",
    },
  });
}

export function registerMembershipBranchRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  const collectionPath =
    "/organizations/:organizationId/members/:membershipId/branches";
  const assignmentPath = `${collectionPath}/:branchId`;

  app.get(collectionPath, async (request, reply) => {
    const path = membershipPathSchema.safeParse(request.params);
    if (!path.success) return send(reply, notFound());

    const result = await authorization.withPermission(
      requestContext(request),
      "core.organization.user.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!matchesOrganization(path.data.organizationId, context)) {
          return notFound();
        }
        if (
          !hasOrganizationPermission(context, "core.organization.user.read")
        ) {
          return forbidden();
        }
        const [membership] = await transaction
          .select({
            id: organizationMemberships.id,
            branchAccessMode: organizationMemberships.branchAccessMode,
          })
          .from(organizationMemberships)
          .where(
            and(
              eq(
                organizationMemberships.organizationId,
                context.organizationId,
              ),
              eq(organizationMemberships.id, path.data.membershipId),
            ),
          )
          .limit(1);
        if (!membership) return notFound();
        const assignedBranches = await listAssignedBranches(
          transaction,
          context.organizationId,
          membership.id,
        );
        return {
          statusCode: 200,
          body: {
            membershipId: membership.id,
            branchAccessMode: membership.branchAccessMode,
            assignedBranches,
          },
        };
      },
    );
    if (!result.allowed)
      return send(reply, permissionDenied(result.statusCode));
    return send(reply, result.value);
  });

  app.post(collectionPath, async (request, reply) => {
    const path = membershipPathSchema.safeParse(request.params);
    const body = branchIdsSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, badRequest());

    const result = await authorization.withPermission(
      requestContext(request),
      "core.organization.user.update",
      { requestId: request.id },
      async (transaction, context) => {
        if (!matchesOrganization(path.data.organizationId, context)) {
          return notFound();
        }
        if (
          !hasOrganizationPermission(context, "core.organization.user.update")
        ) {
          return forbidden();
        }
        if (path.data.membershipId === context.membershipId) {
          await logSelfAssignmentDenial(
            transaction,
            context,
            request.id,
            path.data.membershipId,
            null,
          );
          return forbidden();
        }
        const [membership] = await transaction
          .select({
            id: organizationMemberships.id,
            branchAccessMode: organizationMemberships.branchAccessMode,
          })
          .from(organizationMemberships)
          .where(
            and(
              eq(
                organizationMemberships.organizationId,
                context.organizationId,
              ),
              eq(organizationMemberships.id, path.data.membershipId),
              eq(organizationMemberships.status, "ACTIVE"),
            ),
          )
          .limit(1);
        if (!membership) return notFound();
        if (membership.branchAccessMode === "ALL") {
          return allBranchesConflict();
        }
        const validBranches = await transaction
          .select({ id: branches.id })
          .from(branches)
          .where(
            and(
              eq(branches.organizationId, context.organizationId),
              eq(branches.status, "ACTIVE"),
              inArray(branches.id, body.data.branchIds),
            ),
          );
        if (validBranches.length !== body.data.branchIds.length) {
          return notFound();
        }
        const inserted = await transaction
          .insert(membershipBranches)
          .values(
            body.data.branchIds.map((branchId) => ({
              organizationId: context.organizationId,
              membershipId: membership.id,
              branchId,
            })),
          )
          .onConflictDoNothing()
          .returning({ branchId: membershipBranches.branchId });
        for (const assignment of inserted) {
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "membership.branch.assigned",
            "membership_branch",
            `${membership.id}:${assignment.branchId}`,
            {
              membershipId: membership.id,
              targetBranchId: assignment.branchId,
            },
          );
        }
        const assignedBranches = await listAssignedBranches(
          transaction,
          context.organizationId,
          membership.id,
        );
        return {
          statusCode: 200,
          body: {
            membershipId: membership.id,
            branchAccessMode: membership.branchAccessMode,
            assignedBranches,
          },
        };
      },
    );
    if (!result.allowed)
      return send(reply, permissionDenied(result.statusCode));
    return send(reply, result.value);
  });

  app.delete(assignmentPath, async (request, reply) => {
    const path = assignmentPathSchema.safeParse(request.params);
    if (!path.success) return send(reply, notFound());

    const result = await authorization.withPermission(
      requestContext(request),
      "core.organization.user.update",
      { requestId: request.id },
      async (transaction, context) => {
        if (!matchesOrganization(path.data.organizationId, context)) {
          return notFound();
        }
        if (
          !hasOrganizationPermission(context, "core.organization.user.update")
        ) {
          return forbidden();
        }
        if (path.data.membershipId === context.membershipId) {
          await logSelfAssignmentDenial(
            transaction,
            context,
            request.id,
            path.data.membershipId,
            path.data.branchId,
          );
          return forbidden();
        }
        const [membership] = await transaction
          .select({
            id: organizationMemberships.id,
            branchAccessMode: organizationMemberships.branchAccessMode,
          })
          .from(organizationMemberships)
          .where(
            and(
              eq(
                organizationMemberships.organizationId,
                context.organizationId,
              ),
              eq(organizationMemberships.id, path.data.membershipId),
            ),
          )
          .limit(1);
        if (!membership) return notFound();
        if (membership.branchAccessMode === "ALL") {
          return allBranchesConflict();
        }
        const [removed] = await transaction
          .delete(membershipBranches)
          .where(
            and(
              eq(membershipBranches.organizationId, context.organizationId),
              eq(membershipBranches.membershipId, membership.id),
              eq(membershipBranches.branchId, path.data.branchId),
            ),
          )
          .returning({ branchId: membershipBranches.branchId });
        if (!removed) return notFound();
        await writeAuthorizationMutationEvent(
          transaction,
          context,
          { requestId: request.id },
          "membership.branch.unassigned",
          "membership_branch",
          `${membership.id}:${removed.branchId}`,
          { membershipId: membership.id, targetBranchId: removed.branchId },
        );
        return {
          statusCode: 200,
          body: {
            removed: true,
            membershipId: membership.id,
            branchId: removed.branchId,
          },
        };
      },
    );
    if (!result.allowed)
      return send(reply, permissionDenied(result.statusCode));
    return send(reply, result.value);
  });
}
