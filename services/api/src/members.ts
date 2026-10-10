import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  denyAllAuthorizationService,
  membershipRoles,
  organizationMemberships,
  roles,
  users,
  type AuthorizationContext,
  type AuthorizationService,
} from "@onecore/database";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const membershipRolesPathSchema = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
});
const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const readPermission = "core.organization.user.read";
const roleReadPermission = "core.rbac.role.read";

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
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return reply.status(result.value.statusCode).send(result.value.body);
    },
  );
}
