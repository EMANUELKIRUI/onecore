import { and, asc, eq } from "drizzle-orm";
import {
  auditLogs,
  denyAllAuthorizationService,
  membershipRoles,
  organizationMemberships,
  permissions,
  rolePermissions,
  roles,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationMetadata,
  type AuthorizationService,
  type OrganizationTransaction,
} from "@onecore/database";
import {
  dataScopeTypeSchema,
  organizationOwnerPermissionKey,
  type DataScopeType,
} from "@onecore/core-domain";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import { recordUserRoleChangedEvent } from "./event-publication.js";

const pathSchema = z.object({ roleId: z.uuid() });
const permissionPathSchema = pathSchema.extend({ permissionId: z.uuid() });
const membershipPathSchema = z.object({
  membershipId: z.uuid(),
  roleId: z.uuid(),
});
const createRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();
const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
const rolePermissionSchema = z
  .object({
    permissionId: z.uuid(),
    scopeType: dataScopeTypeSchema.default("ORGANIZATION"),
    scope: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine(
    (body) => body.scopeType !== "CUSTOM" || Object.keys(body.scope).length > 0,
    { path: ["scope"], message: "CUSTOM scope requires a non-empty scope" },
  );
const membershipRoleSchema = z
  .object({
    membershipId: z.uuid(),
    roleId: z.uuid(),
  })
  .strict();

const roleRead = "core.rbac.role.read";
const permissionRead = "core.rbac.permission.read";
const roleCreate = "core.rbac.role.create";
const roleUpdate = "core.rbac.role.update";
const roleDisable = "core.rbac.role.disable";
const rolePermissionAssign = "core.rbac.role_permission.assign";
const rolePermissionRevoke = "core.rbac.role_permission.revoke";
const membershipRoleAssign = "core.rbac.membership_role.assign";
const membershipRoleRemove = "core.rbac.membership_role.remove";

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: {
  auth: {
    userId: string;
    sessionId: string;
    organizationId: string | null;
    membershipId: string | null;
    branchId: string | null;
  } | null;
}): AuthorizationContext | null {
  const authenticated = request.auth;
  if (!authenticated) return null;
  return {
    userId: authenticated.userId,
    sessionId: authenticated.sessionId,
    organizationId: authenticated.organizationId,
    membershipId: authenticated.membershipId,
    branchId: authenticated.branchId,
  };
}

function permissionDenied(
  reply: {
    status: (statusCode: number) => {
      send: (body: unknown) => unknown;
    };
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

function sendOperationResponse(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  response: OperationResponse,
) {
  return reply.status(response.statusCode).send(response.body);
}

function canDelegateScope(
  actorScopes: readonly DataScopeType[],
  requestedScope: DataScopeType,
): boolean {
  return actorScopes.some(
    (scope) => scope === "ORGANIZATION" || scope === requestedScope,
  );
}

function hasOrganizationScope(
  context: AuthorizationContext & {
    permissions: { key: string; scopeType: DataScopeType }[];
  },
  permissionKey: string,
): boolean {
  return context.permissions.some(
    (permission) =>
      permission.key === permissionKey &&
      permission.scopeType === "ORGANIZATION",
  );
}

async function logEscalationDenial(
  transaction: OrganizationTransaction,
  context: AuthorizationContext & {
    organizationId: string;
    membershipId: string;
  },
  metadata: AuthorizationMetadata,
  permissionKey: string,
  target: string,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action: "authorization.permission.denied",
    resource: "permission",
    resourceId: permissionKey,
    result: "FAILURE",
    requestMetadata: {
      requestId: metadata.requestId,
      branchId: context.branchId,
      reason: "privilege_escalation_prevented",
      target,
    },
  });
}

function response(statusCode: number, body: unknown): OperationResponse {
  return { statusCode, body };
}

export function registerAuthorizationRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  app.get("/permissions", async (request, reply) => {
    const result = await authorization.withPermission(
      requestContext(request),
      permissionRead,
      { requestId: request.id },
      async (transaction) => {
        const catalog = await transaction
          .select({
            id: permissions.id,
            key: permissions.key,
            module: permissions.moduleKey,
            resource: permissions.resourceKey,
            action: permissions.actionKey,
            description: permissions.description,
            isSystem: permissions.isSystem,
          })
          .from(permissions)
          .where(eq(permissions.status, "ACTIVE"))
          .orderBy(asc(permissions.moduleKey), asc(permissions.key));
        return response(200, { permissions: catalog });
      },
    );
    if (!result.allowed) return permissionDenied(reply, result.statusCode);
    return sendOperationResponse(reply, result.value);
  });

  app.get("/roles", async (request, reply) => {
    const result = await authorization.withPermission(
      requestContext(request),
      roleRead,
      { requestId: request.id },
      async (transaction, context) => {
        const organizationRoles = await transaction
          .select({
            id: roles.id,
            name: roles.name,
            description: roles.description,
            status: roles.status,
            isSystem: roles.isSystem,
            createdAt: roles.createdAt,
            updatedAt: roles.updatedAt,
          })
          .from(roles)
          .where(eq(roles.organizationId, context.organizationId))
          .orderBy(asc(roles.name));
        return response(200, { roles: organizationRoles });
      },
    );
    if (!result.allowed) return permissionDenied(reply, result.statusCode);
    return sendOperationResponse(reply, result.value);
  });

  app.post("/roles", async (request, reply) => {
    const parsed = createRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "Invalid role definition." },
      });
    }
    const result = await authorization.withPermission(
      requestContext(request),
      roleCreate,
      { requestId: request.id },
      async (transaction, context) => {
        if (!hasOrganizationScope(context, roleCreate)) {
          await logEscalationDenial(
            transaction,
            context,
            { requestId: request.id },
            roleCreate,
            "organization_role",
          );
          return response(403, {
            error: {
              code: "FORBIDDEN",
              message: "The request is not authorized.",
            },
          });
        }
        const [role] = await transaction
          .insert(roles)
          .values({
            organizationId: context.organizationId,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
          })
          .onConflictDoNothing({
            target: [roles.organizationId, roles.name],
          })
          .returning({
            id: roles.id,
            name: roles.name,
            description: roles.description,
            status: roles.status,
            isSystem: roles.isSystem,
          });
        if (!role) {
          return response(409, {
            error: {
              code: "CONFLICT",
              message: "A role with that name already exists.",
            },
          });
        }
        await writeAuthorizationMutationEvent(
          transaction,
          context,
          { requestId: request.id },
          "role.created",
          "role",
          role.id,
          { name: role.name },
        );
        return response(201, { role });
      },
    );
    if (!result.allowed) return permissionDenied(reply, result.statusCode);
    return sendOperationResponse(reply, result.value);
  });

  app.get<{ Params: { roleId: string } }>(
    "/roles/:roleId",
    async (request, reply) => {
      const parsedParams = pathSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "The requested role was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        roleRead,
        { requestId: request.id },
        async (transaction, context) => {
          const [role] = await transaction
            .select({
              id: roles.id,
              name: roles.name,
              description: roles.description,
              status: roles.status,
              isSystem: roles.isSystem,
              createdAt: roles.createdAt,
              updatedAt: roles.updatedAt,
            })
            .from(roles)
            .where(
              and(
                eq(roles.id, parsedParams.data.roleId),
                eq(roles.organizationId, context.organizationId),
              ),
            )
            .limit(1);
          if (!role) {
            return response(404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested role was not found.",
              },
            });
          }
          const assignedPermissions = await transaction
            .select({
              id: permissions.id,
              key: permissions.key,
              scopeType: rolePermissions.scopeType,
              scope: rolePermissions.scope,
            })
            .from(rolePermissions)
            .innerJoin(
              permissions,
              eq(rolePermissions.permissionId, permissions.id),
            )
            .where(
              and(
                eq(rolePermissions.organizationId, context.organizationId),
                eq(rolePermissions.roleId, role.id),
              ),
            )
            .orderBy(asc(permissions.key));
          return response(200, { role, permissions: assignedPermissions });
        },
      );
      if (!result.allowed) return permissionDenied(reply, result.statusCode);
      return sendOperationResponse(reply, result.value);
    },
  );

  app.patch<{ Params: { roleId: string } }>(
    "/roles/:roleId",
    async (request, reply) => {
      const parsedParams = pathSchema.safeParse(request.params);
      const parsedBody = updateRoleSchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid role update." },
        });
      }
      const requiredPermissions = [roleUpdate];
      if (parsedBody.data.status === "INACTIVE") {
        requiredPermissions.push(roleDisable);
      }
      const result = await authorization.withAllPermissions(
        requestContext(request),
        requiredPermissions,
        { requestId: request.id },
        async (transaction, context) => {
          if (
            requiredPermissions.some(
              (permission) => !hasOrganizationScope(context, permission),
            )
          ) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              roleUpdate,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [heldRole] = await transaction
            .select({ roleId: membershipRoles.roleId })
            .from(membershipRoles)
            .where(
              and(
                eq(membershipRoles.organizationId, context.organizationId),
                eq(membershipRoles.membershipId, context.membershipId),
                eq(membershipRoles.roleId, parsedParams.data.roleId),
              ),
            )
            .limit(1);
          if (heldRole) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              roleUpdate,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          if (parsedBody.data.status === "INACTIVE") {
            const [ownerCapability] = await transaction
              .select({ permissionId: rolePermissions.permissionId })
              .from(rolePermissions)
              .innerJoin(
                permissions,
                eq(rolePermissions.permissionId, permissions.id),
              )
              .where(
                and(
                  eq(rolePermissions.organizationId, context.organizationId),
                  eq(rolePermissions.roleId, parsedParams.data.roleId),
                  eq(permissions.key, organizationOwnerPermissionKey),
                ),
              )
              .limit(1);
            if (ownerCapability) {
              await logEscalationDenial(
                transaction,
                context,
                { requestId: request.id },
                roleDisable,
                parsedParams.data.roleId,
              );
              return response(403, {
                error: {
                  code: "FORBIDDEN",
                  message: "The request is not authorized.",
                },
              });
            }
          }
          const [updated] = await transaction
            .update(roles)
            .set({ ...parsedBody.data, updatedAt: new Date() })
            .where(
              and(
                eq(roles.id, parsedParams.data.roleId),
                eq(roles.organizationId, context.organizationId),
              ),
            )
            .returning({
              id: roles.id,
              name: roles.name,
              description: roles.description,
              status: roles.status,
              isSystem: roles.isSystem,
            });
          if (!updated) {
            return response(404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested role was not found.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            updated.status === "INACTIVE" ? "role.disabled" : "role.updated",
            "role",
            updated.id,
            { name: updated.name },
          );
          return response(200, { role: updated });
        },
      );
      if (!result.allowed) return permissionDenied(reply, result.statusCode);
      return sendOperationResponse(reply, result.value);
    },
  );

  app.post<{ Params: { roleId: string } }>(
    "/roles/:roleId/permissions",
    async (request, reply) => {
      const parsedParams = pathSchema.safeParse(request.params);
      const parsedBody = rolePermissionSchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid role permission." },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        rolePermissionAssign,
        { requestId: request.id },
        async (transaction, context) => {
          if (!hasOrganizationScope(context, rolePermissionAssign)) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              rolePermissionAssign,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [role] = await transaction
            .select({ id: roles.id })
            .from(roles)
            .where(
              and(
                eq(roles.id, parsedParams.data.roleId),
                eq(roles.organizationId, context.organizationId),
                eq(roles.status, "ACTIVE"),
              ),
            )
            .limit(1);
          if (!role) {
            return response(404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested role was not found.",
              },
            });
          }
          const [heldRole] = await transaction
            .select({ roleId: membershipRoles.roleId })
            .from(membershipRoles)
            .where(
              and(
                eq(membershipRoles.organizationId, context.organizationId),
                eq(membershipRoles.membershipId, context.membershipId),
                eq(membershipRoles.roleId, role.id),
              ),
            )
            .limit(1);
          const [permission] = await transaction
            .select({
              id: permissions.id,
              key: permissions.key,
              status: permissions.status,
            })
            .from(permissions)
            .where(eq(permissions.id, parsedBody.data.permissionId))
            .limit(1);
          const actorScopes =
            context.permissions
              .filter((entry) => entry.key === permission?.key)
              .map((entry) => entry.scopeType) ?? [];
          if (
            heldRole ||
            !permission ||
            permission.status !== "ACTIVE" ||
            permission.key === organizationOwnerPermissionKey ||
            !canDelegateScope(actorScopes, parsedBody.data.scopeType)
          ) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              rolePermissionAssign,
              role.id,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [assignment] = await transaction
            .insert(rolePermissions)
            .values({
              organizationId: context.organizationId,
              roleId: role.id,
              permissionId: permission.id,
              scopeType: parsedBody.data.scopeType,
              scope: parsedBody.data.scope,
            })
            .onConflictDoNothing()
            .returning({ permissionId: rolePermissions.permissionId });
          if (!assignment) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "The permission is already assigned to this role.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "role.permission.granted",
            "role_permission",
            `${role.id}:${permission.id}`,
            {
              permissionKey: permission.key,
              scopeType: parsedBody.data.scopeType,
            },
          );
          return response(201, {
            roleId: role.id,
            permissionId: permission.id,
            permissionKey: permission.key,
            scopeType: parsedBody.data.scopeType,
          });
        },
      );
      if (!result.allowed) return permissionDenied(reply, result.statusCode);
      return sendOperationResponse(reply, result.value);
    },
  );

  app.delete<{ Params: { roleId: string; permissionId: string } }>(
    "/roles/:roleId/permissions/:permissionId",
    async (request, reply) => {
      const parsedParams = permissionPathSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "The requested assignment was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        rolePermissionRevoke,
        { requestId: request.id },
        async (transaction, context) => {
          if (!hasOrganizationScope(context, rolePermissionRevoke)) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              rolePermissionRevoke,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [heldRole] = await transaction
            .select({ roleId: membershipRoles.roleId })
            .from(membershipRoles)
            .where(
              and(
                eq(membershipRoles.organizationId, context.organizationId),
                eq(membershipRoles.membershipId, context.membershipId),
                eq(membershipRoles.roleId, parsedParams.data.roleId),
              ),
            )
            .limit(1);
          if (heldRole) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              rolePermissionRevoke,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [ownerPermission] = await transaction
            .select({ id: permissions.id })
            .from(rolePermissions)
            .innerJoin(
              permissions,
              eq(rolePermissions.permissionId, permissions.id),
            )
            .where(
              and(
                eq(rolePermissions.organizationId, context.organizationId),
                eq(rolePermissions.roleId, parsedParams.data.roleId),
                eq(
                  rolePermissions.permissionId,
                  parsedParams.data.permissionId,
                ),
                eq(permissions.key, organizationOwnerPermissionKey),
              ),
            )
            .limit(1);
          if (ownerPermission) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              rolePermissionRevoke,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [removed] = await transaction
            .delete(rolePermissions)
            .where(
              and(
                eq(rolePermissions.organizationId, context.organizationId),
                eq(rolePermissions.roleId, parsedParams.data.roleId),
                eq(
                  rolePermissions.permissionId,
                  parsedParams.data.permissionId,
                ),
              ),
            )
            .returning({ roleId: rolePermissions.roleId });
          if (!removed) {
            return response(404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested assignment was not found.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "role.permission.revoked",
            "role_permission",
            `${removed.roleId}:${parsedParams.data.permissionId}`,
          );
          return response(200, { removed: true });
        },
      );
      if (!result.allowed) return permissionDenied(reply, result.statusCode);
      return sendOperationResponse(reply, result.value);
    },
  );

  app.post("/auth/membership/roles", async (request, reply) => {
    const parsedBody = membershipRoleSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "Invalid membership role assignment.",
        },
      });
    }
    const result = await authorization.withPermission(
      requestContext(request),
      membershipRoleAssign,
      { requestId: request.id },
      async (transaction, context) => {
        if (!hasOrganizationScope(context, membershipRoleAssign)) {
          await logEscalationDenial(
            transaction,
            context,
            { requestId: request.id },
            membershipRoleAssign,
            parsedBody.data.roleId,
          );
          return response(403, {
            error: {
              code: "FORBIDDEN",
              message: "The request is not authorized.",
            },
          });
        }
        if (parsedBody.data.membershipId === context.membershipId) {
          await logEscalationDenial(
            transaction,
            context,
            { requestId: request.id },
            membershipRoleAssign,
            parsedBody.data.roleId,
          );
          return response(403, {
            error: {
              code: "FORBIDDEN",
              message: "The request is not authorized.",
            },
          });
        }
        const [targetMembership] = await transaction
          .select({
            id: organizationMemberships.id,
            userId: organizationMemberships.userId,
          })
          .from(organizationMemberships)
          .where(
            and(
              eq(
                organizationMemberships.organizationId,
                context.organizationId,
              ),
              eq(organizationMemberships.id, parsedBody.data.membershipId),
              eq(organizationMemberships.status, "ACTIVE"),
            ),
          )
          .limit(1);
        const [membership] = await transaction
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(
              eq(roles.id, parsedBody.data.roleId),
              eq(roles.organizationId, context.organizationId),
              eq(roles.status, "ACTIVE"),
            ),
          )
          .limit(1);
        if (!targetMembership || !membership) {
          return response(404, {
            error: {
              code: "NOT_FOUND",
              message: "The requested assignment target was not found.",
            },
          });
        }
        const roleGrants = await transaction
          .select({
            permissionKey: permissions.key,
            scopeType: rolePermissions.scopeType,
            status: permissions.status,
          })
          .from(rolePermissions)
          .innerJoin(
            permissions,
            eq(rolePermissions.permissionId, permissions.id),
          )
          .where(
            and(
              eq(rolePermissions.organizationId, context.organizationId),
              eq(rolePermissions.roleId, membership.id),
            ),
          );
        const overprivileged = roleGrants.some(
          (grant) =>
            grant.permissionKey === organizationOwnerPermissionKey ||
            grant.status !== "ACTIVE" ||
            !canDelegateScope(
              context.permissions
                .filter((permission) => permission.key === grant.permissionKey)
                .map((permission) => permission.scopeType),
              grant.scopeType,
            ),
        );
        if (overprivileged) {
          await logEscalationDenial(
            transaction,
            context,
            { requestId: request.id },
            membershipRoleAssign,
            membership.id,
          );
          return response(403, {
            error: {
              code: "FORBIDDEN",
              message: "The request is not authorized.",
            },
          });
        }
        const [assignment] = await transaction
          .insert(membershipRoles)
          .values({
            organizationId: context.organizationId,
            membershipId: parsedBody.data.membershipId,
            roleId: membership.id,
          })
          .onConflictDoNothing()
          .returning({ roleId: membershipRoles.roleId });
        if (!assignment) {
          return response(409, {
            error: {
              code: "CONFLICT",
              message: "The role is already assigned.",
            },
          });
        }
        await writeAuthorizationMutationEvent(
          transaction,
          context,
          { requestId: request.id },
          "membership.role.assigned",
          "membership_role",
          `${parsedBody.data.membershipId}:${membership.id}`,
        );
        await recordUserRoleChangedEvent(
          transaction,
          context,
          request.id,
          targetMembership.userId,
          parsedBody.data.membershipId,
          membership.id,
          "ASSIGNED",
        );
        return response(201, {
          membershipId: parsedBody.data.membershipId,
          roleId: membership.id,
        });
      },
    );
    if (!result.allowed) return permissionDenied(reply, result.statusCode);
    return sendOperationResponse(reply, result.value);
  });

  app.delete<{ Params: { membershipId: string; roleId: string } }>(
    "/auth/membership/roles/:membershipId/:roleId",
    async (request, reply) => {
      const parsedParams = membershipPathSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "The requested assignment was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        membershipRoleRemove,
        { requestId: request.id },
        async (transaction, context) => {
          if (!hasOrganizationScope(context, membershipRoleRemove)) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              membershipRoleRemove,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          if (parsedParams.data.membershipId === context.membershipId) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              membershipRoleRemove,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [ownerCapability] = await transaction
            .select({ roleId: membershipRoles.roleId })
            .from(membershipRoles)
            .innerJoin(
              rolePermissions,
              and(
                eq(
                  rolePermissions.organizationId,
                  membershipRoles.organizationId,
                ),
                eq(rolePermissions.roleId, membershipRoles.roleId),
              ),
            )
            .innerJoin(
              permissions,
              and(
                eq(rolePermissions.permissionId, permissions.id),
                eq(permissions.key, organizationOwnerPermissionKey),
              ),
            )
            .where(
              and(
                eq(membershipRoles.organizationId, context.organizationId),
                eq(
                  membershipRoles.membershipId,
                  parsedParams.data.membershipId,
                ),
                eq(membershipRoles.roleId, parsedParams.data.roleId),
              ),
            )
            .limit(1);
          if (ownerCapability) {
            await logEscalationDenial(
              transaction,
              context,
              { requestId: request.id },
              membershipRoleRemove,
              parsedParams.data.roleId,
            );
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message: "The request is not authorized.",
              },
            });
          }
          const [targetMembership] = await transaction
            .select({ userId: organizationMemberships.userId })
            .from(organizationMemberships)
            .where(
              and(
                eq(
                  organizationMemberships.organizationId,
                  context.organizationId,
                ),
                eq(organizationMemberships.id, parsedParams.data.membershipId),
              ),
            )
            .for("share")
            .limit(1);
          if (!targetMembership) {
            return response(404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested assignment was not found.",
              },
            });
          }
          const [removed] = await transaction
            .delete(membershipRoles)
            .where(
              and(
                eq(membershipRoles.organizationId, context.organizationId),
                eq(
                  membershipRoles.membershipId,
                  parsedParams.data.membershipId,
                ),
                eq(membershipRoles.roleId, parsedParams.data.roleId),
              ),
            )
            .returning({ roleId: membershipRoles.roleId });
          if (!removed) {
            return response(404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested assignment was not found.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "membership.role.removed",
            "membership_role",
            `${parsedParams.data.membershipId}:${removed.roleId}`,
          );
          await recordUserRoleChangedEvent(
            transaction,
            context,
            request.id,
            targetMembership.userId,
            parsedParams.data.membershipId,
            removed.roleId,
            "REMOVED",
          );
          return response(200, { removed: true });
        },
      );
      if (!result.allowed) return permissionDenied(reply, result.statusCode);
      return sendOperationResponse(reply, result.value);
    },
  );
}
