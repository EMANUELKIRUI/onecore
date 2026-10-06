import { and, asc, eq, inArray } from "drizzle-orm";
import {
  loadOrganizationModuleActivationAccess,
  modules,
  moduleDependencies,
  organizationModules,
  organizations,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationService,
  denyAllAuthorizationService,
} from "@onecore/database";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import { recordModuleEntitlementEvent } from "./event-publication.js";

const modulePathSchema = z.object({
  moduleName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/),
});
const organizationModulePathSchema = modulePathSchema.extend({
  organizationId: z.uuid(),
});

const moduleRead = "core.modules.module.read";
const entitlementRead = "core.modules.entitlement.read";
const entitlementRequest = "core.modules.entitlement.request";
const entitlementManage = "core.modules.entitlement.manage";

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

function sendDenied(
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

function sendResponse(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  statusCode: number,
  body: unknown,
) {
  return reply.status(statusCode).send(body);
}

function organizationTargetMatches(
  organizationId: string,
  context: { organizationId: string },
): boolean {
  return organizationId === context.organizationId;
}

export function registerModuleRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  app.get("/modules", async (request, reply) => {
    const result = await authorization.withPermission(
      requestContext(request),
      moduleRead,
      { requestId: request.id },
      async (transaction, context) => {
        const catalog = await transaction
          .select({
            name: modules.key,
            displayName: modules.name,
            description: modules.description,
            lifecycle: modules.lifecycle,
            available: modules.isAvailable,
            entitlementStatus: organizationModules.status,
          })
          .from(modules)
          .leftJoin(
            organizationModules,
            and(
              eq(organizationModules.moduleId, modules.id),
              eq(organizationModules.organizationId, context.organizationId),
            ),
          )
          .orderBy(asc(modules.key));
        return { catalog };
      },
    );
    if (!result.allowed) return sendDenied(reply, result.statusCode);
    return sendResponse(reply, 200, result.value);
  });

  app.get("/organizations/:organizationId/modules", async (request, reply) => {
    const parsed = organizationModulePathSchema
      .omit({ moduleName: true })
      .safeParse(request.params);
    if (!parsed.success) {
      return sendResponse(reply, 404, {
        error: {
          code: "NOT_FOUND",
          message: "The requested resource was not found.",
        },
      });
    }
    const result = await authorization.withPermission(
      requestContext(request),
      entitlementRead,
      { requestId: request.id },
      async (transaction, context) => {
        if (!organizationTargetMatches(parsed.data.organizationId, context)) {
          return null;
        }
        const entitlements = await transaction
          .select({
            moduleName: modules.key,
            status: organizationModules.status,
            source: organizationModules.source,
            enabledAt: organizationModules.enabledAt,
            updatedAt: organizationModules.updatedAt,
          })
          .from(organizationModules)
          .innerJoin(modules, eq(organizationModules.moduleId, modules.id))
          .where(eq(organizationModules.organizationId, context.organizationId))
          .orderBy(asc(modules.key));
        return { entitlements };
      },
    );
    if (!result.allowed) return sendDenied(reply, result.statusCode);
    if (!result.value) {
      return sendResponse(reply, 404, {
        error: {
          code: "NOT_FOUND",
          message: "The requested resource was not found.",
        },
      });
    }
    return sendResponse(reply, 200, result.value);
  });

  app.post(
    "/organizations/:organizationId/modules/:moduleName/request",
    async (request, reply) => {
      const parsed = organizationModulePathSchema.safeParse(request.params);
      if (!parsed.success) {
        return sendResponse(reply, 404, {
          error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        entitlementRequest,
        { requestId: request.id },
        async (transaction, context) => {
          if (!organizationTargetMatches(parsed.data.organizationId, context)) {
            return sendResponse(reply, 404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested resource was not found.",
              },
            });
          }
          const [module] = await transaction
            .select({
              id: modules.id,
              lifecycle: modules.lifecycle,
              isAvailable: modules.isAvailable,
            })
            .from(modules)
            .where(eq(modules.key, parsed.data.moduleName))
            .limit(1);
          if (
            !module ||
            module.lifecycle !== "AVAILABLE" ||
            !module.isAvailable
          ) {
            return sendResponse(reply, 404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested module is unavailable.",
              },
            });
          }
          const [existing] = await transaction
            .select({ status: organizationModules.status })
            .from(organizationModules)
            .where(
              and(
                eq(organizationModules.organizationId, context.organizationId),
                eq(organizationModules.moduleId, module.id),
              ),
            )
            .limit(1);
          if (existing) {
            if (existing.status === "REQUESTED") {
              return sendResponse(reply, 200, {
                moduleName: parsed.data.moduleName,
                status: "REQUESTED",
              });
            }
            return sendResponse(reply, 409, {
              error: {
                code: "CONFLICT",
                message: "The module entitlement already exists.",
              },
            });
          }
          const [requested] = await transaction
            .insert(organizationModules)
            .values({
              organizationId: context.organizationId,
              moduleId: module.id,
              status: "REQUESTED",
              source: "MANUAL",
            })
            .onConflictDoNothing()
            .returning({
              id: organizationModules.id,
              source: organizationModules.source,
            });
          if (!requested) {
            return sendResponse(reply, 409, {
              error: {
                code: "CONFLICT",
                message: "The module entitlement already exists.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "MODULE_REQUESTED",
            "module_entitlement",
            parsed.data.moduleName,
            { status: "REQUESTED" },
          );
          return sendResponse(reply, 201, {
            moduleName: parsed.data.moduleName,
            status: "REQUESTED",
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return result.value;
    },
  );

  app.post(
    "/organizations/:organizationId/modules/:moduleName/enable",
    async (request, reply) => {
      const parsed = organizationModulePathSchema.safeParse(request.params);
      if (!parsed.success) {
        return sendResponse(reply, 404, {
          error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        entitlementManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!organizationTargetMatches(parsed.data.organizationId, context)) {
            return sendResponse(reply, 404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested resource was not found.",
              },
            });
          }
          await transaction
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, context.organizationId))
            .for("update")
            .limit(1);
          const [module] = await transaction
            .select({
              id: modules.id,
              lifecycle: modules.lifecycle,
              isAvailable: modules.isAvailable,
            })
            .from(modules)
            .where(eq(modules.key, parsed.data.moduleName))
            .limit(1);
          if (!module) {
            return sendResponse(reply, 404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested resource was not found.",
              },
            });
          }
          if (module.lifecycle !== "AVAILABLE" || !module.isAvailable) {
            return sendResponse(reply, 409, {
              error: {
                code: "CONFLICT",
                message: "The module is not available.",
              },
            });
          }
          const [existing] = await transaction
            .select({ status: organizationModules.status })
            .from(organizationModules)
            .where(
              and(
                eq(organizationModules.organizationId, context.organizationId),
                eq(organizationModules.moduleId, module.id),
              ),
            )
            .limit(1);
          if (
            existing &&
            ![
              "REQUESTED",
              "APPROVED",
              "AVAILABLE",
              "DISABLED",
              "EXPIRED",
            ].includes(existing.status)
          ) {
            return sendResponse(reply, 409, {
              error: {
                code: "CONFLICT",
                message: "The module cannot be enabled from its current state.",
              },
            });
          }
          const decision = await loadOrganizationModuleActivationAccess(
            transaction,
            context.organizationId,
            parsed.data.moduleName,
          );
          if (!decision || !decision.allowed) {
            if (decision?.reason === "DEPENDENCY_NOT_SATISFIED") {
              await writeAuthorizationMutationEvent(
                transaction,
                context,
                { requestId: request.id },
                "MODULE_DEPENDENCY_REJECTED",
                "module_entitlement",
                parsed.data.moduleName,
                { reason: decision.reason },
              );
            }
            return sendResponse(reply, 409, {
              error: {
                code: "CONFLICT",
                message:
                  "The module's entitlement requirements are not satisfied.",
              },
            });
          }
          const [enabled] = await transaction
            .insert(organizationModules)
            .values({
              organizationId: context.organizationId,
              moduleId: module.id,
              status: "ENABLED",
              source: "SUBSCRIPTION",
              enabledAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                organizationModules.organizationId,
                organizationModules.moduleId,
              ],
              set: {
                status: "ENABLED",
                source: "SUBSCRIPTION",
                enabledAt: new Date(),
                updatedAt: new Date(),
              },
            })
            .returning({ id: organizationModules.id });
          if (!enabled) throw new Error("Module activation did not persist");
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "MODULE_ENABLED",
            "module_entitlement",
            parsed.data.moduleName,
            { source: "SUBSCRIPTION" },
          );
          await recordModuleEntitlementEvent(
            transaction,
            context,
            request.id,
            parsed.data.moduleName,
            module.id,
            true,
            "SUBSCRIPTION",
          );
          return sendResponse(reply, 200, {
            moduleName: parsed.data.moduleName,
            status: "ENABLED",
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return result.value;
    },
  );

  app.post(
    "/organizations/:organizationId/modules/:moduleName/disable",
    async (request, reply) => {
      const parsed = organizationModulePathSchema.safeParse(request.params);
      if (!parsed.success) {
        return sendResponse(reply, 404, {
          error: {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        entitlementManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!organizationTargetMatches(parsed.data.organizationId, context)) {
            return sendResponse(reply, 404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested resource was not found.",
              },
            });
          }
          await transaction
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, context.organizationId))
            .for("update")
            .limit(1);
          const [module] = await transaction
            .select({ id: modules.id })
            .from(modules)
            .where(eq(modules.key, parsed.data.moduleName))
            .limit(1);
          if (!module) {
            return sendResponse(reply, 404, {
              error: {
                code: "NOT_FOUND",
                message: "The requested resource was not found.",
              },
            });
          }
          const transitiveDependentIds = new Set<string>();
          const dependencyQueue = [module.id];
          while (dependencyQueue.length > 0) {
            const dependencyId = dependencyQueue.shift();
            if (!dependencyId) continue;
            const directDependents = await transaction
              .select({ moduleId: moduleDependencies.moduleId })
              .from(moduleDependencies)
              .where(eq(moduleDependencies.dependencyModuleId, dependencyId));
            for (const dependent of directDependents) {
              if (!transitiveDependentIds.has(dependent.moduleId)) {
                transitiveDependentIds.add(dependent.moduleId);
                dependencyQueue.push(dependent.moduleId);
              }
            }
          }
          if (transitiveDependentIds.size > 0) {
            const enabledDependents = await transaction
              .select({ moduleId: organizationModules.moduleId })
              .from(organizationModules)
              .where(
                and(
                  eq(
                    organizationModules.organizationId,
                    context.organizationId,
                  ),
                  eq(organizationModules.status, "ENABLED"),
                  inArray(organizationModules.moduleId, [
                    ...transitiveDependentIds,
                  ]),
                ),
              );
            if (enabledDependents.length > 0) {
              await writeAuthorizationMutationEvent(
                transaction,
                context,
                { requestId: request.id },
                "MODULE_DEPENDENCY_REJECTED",
                "module_entitlement",
                parsed.data.moduleName,
                { reason: "ENABLED_DEPENDENT_MODULE" },
              );
              return sendResponse(reply, 409, {
                error: {
                  code: "CONFLICT",
                  message:
                    "Disable dependent modules before disabling this module.",
                },
              });
            }
          }
          const [disabled] = await transaction
            .update(organizationModules)
            .set({ status: "DISABLED", enabledAt: null, updatedAt: new Date() })
            .where(
              and(
                eq(organizationModules.organizationId, context.organizationId),
                eq(organizationModules.moduleId, module.id),
                eq(organizationModules.status, "ENABLED"),
              ),
            )
            .returning({
              id: organizationModules.id,
              source: organizationModules.source,
            });
          if (!disabled) {
            return sendResponse(reply, 409, {
              error: {
                code: "CONFLICT",
                message: "The module is not enabled.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "MODULE_DISABLED",
            "module_entitlement",
            parsed.data.moduleName,
          );
          await recordModuleEntitlementEvent(
            transaction,
            context,
            request.id,
            parsed.data.moduleName,
            module.id,
            false,
            disabled.source,
          );
          return sendResponse(reply, 200, {
            moduleName: parsed.data.moduleName,
            status: "DISABLED",
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return result.value;
    },
  );
}
