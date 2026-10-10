import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  branches,
  denyAllAuthorizationService,
  membershipBranches,
  membershipRoles,
  organizationMemberships,
  roles,
  users,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationService,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
} from "@onecore/database";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const membershipRolesPathSchema = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
});
const membershipBranchPathSchema = membershipRolesPathSchema.extend({
  branchId: z.uuid(),
});
const branchAssignmentSchema = z
  .object({ branchIds: z.array(z.uuid()).min(1).max(100) })
  .strict();
const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const readPermission = "core.organization.user.read";
const roleReadPermission = "core.rbac.role.read";
const membershipBranchReadPermission =
  "core.organization.membership_branch.read";
const membershipBranchAssignPermission =
  "core.organization.membership_branch.assign";
const membershipBranchRemovePermission =
  "core.organization.membership_branch.remove";

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function operationResponse(
  statusCode: number,
  code: string,
  message: string,
): OperationResponse {
  return { statusCode, body: { error: { code, message } } };
}

function membershipBranchNotFound(): OperationResponse {
  return operationResponse(
    404,
    "NOT_FOUND",
    "The requested resource was not found.",
  );
}

function membershipBranchForbidden(): OperationResponse {
  return operationResponse(403, "FORBIDDEN", "The request is not authorized.");
}

function membershipBranchConflict(): OperationResponse {
  return operationResponse(
    409,
    "CONFLICT",
    "Explicit branch assignments are not allowed in ALL mode.",
  );
}

function executeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray(result.rows)
  ) {
    return result.rows as Record<string, unknown>[];
  }
  return [];
}

function hasOrganizationPermission(
  context: ResolvedAuthorizationContext,
  permissionKey: string,
): boolean {
  return context.permissions.some(
    (permission) =>
      permission.key === permissionKey &&
      permission.scopeType === "ORGANIZATION",
  );
}

async function logMembershipBranchDenial(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  permissionKey: string,
  reason: string,
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
      reason,
      target: "membership_branch",
    },
  });
}

function requestContext(request: {
  auth: AuthorizationContext | null;
}): AuthorizationContext | null {
  return request.auth;
}

function denied(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  statusCode: 401 | 403,
) {
  return reply.status(statusCode).send({
    error: {
      code: statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      message:
        statusCode === 401
          ? "Authentication is required."
          : "The request is not authorized.",
    },
  });
}

export function registerMemberRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  app.get("/organizations/:organizationId/members", async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = paginationSchema.safeParse(request.query);
    if (!path.success || !query.success) {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "The requested resource was not found.",
        },
      });
    }
    const result = await authorization.withPermission(
      requestContext(request),
      readPermission,
      { requestId: request.id },
      async (transaction, context) => {
        if (context.organizationId !== path.data.organizationId) {
          return {
            statusCode: 404,
            body: {
              error: {
                code: "NOT_FOUND",
                message: "The requested resource was not found.",
              },
            },
          };
        }
        const hasOrganizationScope = context.permissions.some(
          (permission) =>
            permission.key === readPermission &&
            permission.scopeType === "ORGANIZATION",
        );
        if (!hasOrganizationScope) {
          await transaction.insert(auditLogs).values({
            organizationId: context.organizationId,
            actorUserId: context.userId,
            action: "authorization.permission.denied",
            resource: "permission",
            resourceId: readPermission,
            result: "FAILURE",
            requestMetadata: {
              requestId: request.id,
              branchId: context.branchId,
              reason: "insufficient_scope",
              target: "organization_membership",
            },
          });
          return {
            statusCode: 403,
            body: {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            },
          };
        }

        await transaction.execute(
          sql`SELECT set_config('app.current_user_directory_organization_id', ${context.organizationId}, true)`,
        );
        const rows = await transaction
          .select({
            id: organizationMemberships.id,
            email: users.email,
            displayName: users.displayName,
            status: organizationMemberships.status,
            createdAt: organizationMemberships.createdAt,
          })
          .from(organizationMemberships)
          .innerJoin(users, eq(organizationMemberships.userId, users.id))
          .where(
            eq(organizationMemberships.organizationId, context.organizationId),
          )
          .orderBy(
            asc(users.displayName),
            asc(users.email),
            asc(organizationMemberships.id),
          )
          .limit(query.data.limit + 1)
          .offset(query.data.offset);
        const hasMore = rows.length > query.data.limit;
        return {
          statusCode: 200,
          body: {
            members: rows.slice(0, query.data.limit).map((member) => ({
              id: member.id,
              email: member.email,
              displayName: member.displayName,
              status: member.status,
              createdAt: member.createdAt.toISOString(),
            })),
            limit: query.data.limit,
            offset: query.data.offset,
            hasMore,
          },
        };
      },
    );
    if (!result.allowed) return denied(reply, result.statusCode);
    return reply.status(result.value.statusCode).send(result.value.body);
  });

  app.get(
    "/organizations/:organizationId/members/:membershipId/branches",
    async (request, reply) => {
      const path = membershipRolesPathSchema.safeParse(request.params);
      if (!path.success) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        membershipBranchReadPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return membershipBranchNotFound();
          }
          if (
            !hasOrganizationPermission(context, membershipBranchReadPermission)
          ) {
            await logMembershipBranchDenial(
              transaction,
              context,
              request.id,
              membershipBranchReadPermission,
              "insufficient_scope",
            );
            return membershipBranchForbidden();
          }
          const [membership] = await transaction
            .select({
              id: organizationMemberships.id,
              status: organizationMemberships.status,
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
            .for("share")
            .limit(1);
          if (!membership || membership.status !== "ACTIVE") {
            return membershipBranchNotFound();
          }

          const allBranches = await transaction
            .select({
              id: branches.id,
              name: branches.name,
              code: branches.code,
              status: branches.status,
            })
            .from(branches)
            .where(eq(branches.organizationId, context.organizationId))
            .orderBy(asc(branches.name), asc(branches.id));
          const explicitAssignments = await transaction
            .select({
              id: branches.id,
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
                eq(membershipBranches.organizationId, context.organizationId),
                eq(membershipBranches.membershipId, membership.id),
              ),
            )
            .orderBy(asc(branches.name), asc(branches.id));
          const activeBranches = allBranches.filter(
            (branch) => branch.status === "ACTIVE",
          );
          const effectiveBranches =
            membership.branchAccessMode === "ALL"
              ? activeBranches
              : explicitAssignments.filter(
                  (branch) => branch.status === "ACTIVE",
                );
          return {
            statusCode: 200,
            body: {
              membershipId: membership.id,
              branchAccessMode: membership.branchAccessMode,
              explicitAssignments,
              availableBranches: activeBranches,
              effectiveAccess: {
                mode: membership.branchAccessMode,
                branches: effectiveBranches,
              },
              capabilities: {
                canAssign:
                  hasOrganizationPermission(
                    context,
                    membershipBranchAssignPermission,
                  ) &&
                  context.membershipId !== membership.id &&
                  membership.branchAccessMode === "ASSIGNED",
                canRemove:
                  hasOrganizationPermission(
                    context,
                    membershipBranchRemovePermission,
                  ) &&
                  context.membershipId !== membership.id &&
                  membership.branchAccessMode === "ASSIGNED",
              },
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return reply.status(result.value.statusCode).send(result.value.body);
    },
  );

  app.post(
    "/organizations/:organizationId/members/:membershipId/branches",
    async (request, reply) => {
      const path = membershipRolesPathSchema.safeParse(request.params);
      const body = branchAssignmentSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "The request could not be processed.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        membershipBranchAssignPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return membershipBranchNotFound();
          }
          if (
            !hasOrganizationPermission(
              context,
              membershipBranchAssignPermission,
            )
          ) {
            await logMembershipBranchDenial(
              transaction,
              context,
              request.id,
              membershipBranchAssignPermission,
              "insufficient_scope",
            );
            return membershipBranchForbidden();
          }
          const [membership] = await transaction
            .select({
              id: organizationMemberships.id,
              status: organizationMemberships.status,
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
            .for("update")
            .limit(1);
          if (!membership || membership.status !== "ACTIVE") {
            return membershipBranchNotFound();
          }
          if (context.membershipId === membership.id) {
            await logMembershipBranchDenial(
              transaction,
              context,
              request.id,
              membershipBranchAssignPermission,
              "self_targeted_membership",
            );
            return membershipBranchForbidden();
          }
          if (membership.branchAccessMode === "ALL") {
            return membershipBranchConflict();
          }

          const branchIds = [...new Set(body.data.branchIds)];
          const activeBranches = await transaction
            .select({ id: branches.id })
            .from(branches)
            .where(
              and(
                eq(branches.organizationId, context.organizationId),
                inArray(branches.id, branchIds),
                eq(branches.status, "ACTIVE"),
              ),
            )
            .orderBy(asc(branches.id))
            .for("share");
          if (activeBranches.length !== branchIds.length) {
            return membershipBranchNotFound();
          }
          const addedBranchIds: string[] = [];
          for (const branchId of branchIds) {
            const inserted = await transaction.execute(sql`
              INSERT INTO "membership_branches" (
                "organization_id",
                "membership_id",
                "branch_id"
              )
              VALUES (
                ${context.organizationId},
                ${membership.id},
                ${branchId}
              )
              ON CONFLICT DO NOTHING
              RETURNING "branch_id"
            `);
            const insertedBranchId = executeRows(inserted)[0]?.branch_id;
            if (insertedBranchId !== undefined) {
              const parsedBranchId = z.uuid().safeParse(insertedBranchId);
              if (!parsedBranchId.success) {
                throw new Error(
                  "Assigned branch returned an invalid identifier",
                );
              }
              addedBranchIds.push(parsedBranchId.data);
            }
          }
          for (const branchId of addedBranchIds) {
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              "membership.branch.assigned",
              "membership_branch",
              `${membership.id}:${branchId}`,
              { membershipId: membership.id, branchId },
            );
          }
          return {
            statusCode: 200,
            body: {
              membershipId: membership.id,
              assignedBranchIds: branchIds,
              addedBranchIds,
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return reply.status(result.value.statusCode).send(result.value.body);
    },
  );

  app.delete(
    "/organizations/:organizationId/members/:membershipId/branches/:branchId",
    async (request, reply) => {
      const path = membershipBranchPathSchema.safeParse(request.params);
      if (!path.success) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        membershipBranchRemovePermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return membershipBranchNotFound();
          }
          if (
            !hasOrganizationPermission(
              context,
              membershipBranchRemovePermission,
            )
          ) {
            await logMembershipBranchDenial(
              transaction,
              context,
              request.id,
              membershipBranchRemovePermission,
              "insufficient_scope",
            );
            return membershipBranchForbidden();
          }
          const [membership] = await transaction
            .select({
              id: organizationMemberships.id,
              status: organizationMemberships.status,
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
            .for("update")
            .limit(1);
          if (!membership || membership.status !== "ACTIVE") {
            return membershipBranchNotFound();
          }
          if (context.membershipId === membership.id) {
            await logMembershipBranchDenial(
              transaction,
              context,
              request.id,
              membershipBranchRemovePermission,
              "self_targeted_membership",
            );
            return membershipBranchForbidden();
          }
          if (membership.branchAccessMode === "ALL") {
            return membershipBranchConflict();
          }
          const [branch] = await transaction
            .select({ id: branches.id })
            .from(branches)
            .where(
              and(
                eq(branches.organizationId, context.organizationId),
                eq(branches.id, path.data.branchId),
              ),
            )
            .for("share")
            .limit(1);
          if (!branch) return membershipBranchNotFound();

          const [removed] = await transaction
            .delete(membershipBranches)
            .where(
              and(
                eq(membershipBranches.organizationId, context.organizationId),
                eq(membershipBranches.membershipId, membership.id),
                eq(membershipBranches.branchId, branch.id),
              ),
            )
            .returning({ branchId: membershipBranches.branchId });
          if (!removed) return membershipBranchNotFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "membership.branch.removed",
            "membership_branch",
            `${membership.id}:${branch.id}`,
            { membershipId: membership.id, branchId: branch.id },
          );
          return {
            statusCode: 200,
            body: {
              membershipId: membership.id,
              branchId: branch.id,
              removed: true,
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return reply.status(result.value.statusCode).send(result.value.body);
    },
  );

  app.get(
    "/organizations/:organizationId/members/:membershipId/roles",
    async (request, reply) => {
      const path = membershipRolesPathSchema.safeParse(request.params);
      if (!path.success) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        roleReadPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return {
              statusCode: 404,
              body: {
                error: {
                  code: "NOT_FOUND",
                  message: "The requested resource was not found.",
                },
              },
            };
          }
          const hasOrganizationScope = context.permissions.some(
            (permission) =>
              permission.key === roleReadPermission &&
              permission.scopeType === "ORGANIZATION",
          );
          if (!hasOrganizationScope) {
            await transaction.insert(auditLogs).values({
              organizationId: context.organizationId,
              actorUserId: context.userId,
              action: "authorization.permission.denied",
              resource: "permission",
              resourceId: roleReadPermission,
              result: "FAILURE",
              requestMetadata: {
                requestId: request.id,
                branchId: context.branchId,
                reason: "insufficient_scope",
                target: "membership_roles",
              },
            });
            return {
              statusCode: 403,
              body: {
                error: {
                  code: "FORBIDDEN",
                  message: "The request is not authorized.",
                },
              },
            };
          }
          const [membership] = await transaction
            .select({ id: organizationMemberships.id })
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
          if (!membership) {
            return {
              statusCode: 404,
              body: {
                error: {
                  code: "NOT_FOUND",
                  message: "The requested resource was not found.",
                },
              },
            };
          }

          const assignedRoles = await transaction
            .select({
              id: roles.id,
              name: roles.name,
              status: roles.status,
            })
            .from(membershipRoles)
            .innerJoin(
              roles,
              and(
                eq(roles.organizationId, membershipRoles.organizationId),
                eq(roles.id, membershipRoles.roleId),
              ),
            )
            .where(
              and(
                eq(membershipRoles.organizationId, context.organizationId),
                eq(membershipRoles.membershipId, membership.id),
              ),
            )
            .orderBy(asc(roles.name));
          const availableRoles = await transaction
            .select({
              id: roles.id,
              name: roles.name,
            })
            .from(roles)
            .where(
              and(
                eq(roles.organizationId, context.organizationId),
                eq(roles.status, "ACTIVE"),
              ),
            )
            .orderBy(asc(roles.name));
          return {
            statusCode: 200,
            body: {
              membershipId: membership.id,
              assignedRoles,
              availableRoles,
              capabilities: {
                canAssign:
                  hasOrganizationPermission(
                    context,
                    "core.rbac.membership_role.assign",
                  ) && context.membershipId !== membership.id,
                canRemove:
                  hasOrganizationPermission(
                    context,
                    "core.rbac.membership_role.remove",
                  ) && context.membershipId !== membership.id,
              },
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return reply.status(result.value.statusCode).send(result.value.body);
    },
  );
}
