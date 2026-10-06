import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  businessSettings,
  featureFlagAssignments,
  featureFlags,
  loadOrganizationModuleAccess,
  modules,
  organizationBranding,
  organizationSettings,
  organizations,
  resolveFeatureFlag,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationService,
  denyAllAuthorizationService,
  type FeatureFlagValue,
} from "@onecore/database";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import {
  parseFeatureFlagValue,
  resolveConfigurationCapabilities,
} from "@onecore/core-domain";
import {
  recordConfigurationChangedEvent,
  recordFeatureFlagChangedEvent,
} from "./event-publication.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const featurePathSchema = organizationPathSchema.extend({
  flagName: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Z][A-Z0-9_]*$/),
});
const featureResolutionQuerySchema = z
  .object({ moduleKey: z.string().trim().min(1).max(100).optional() })
  .strict();
const emailBrandingSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    footerText: z.string().trim().max(500).optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    logoReference: z
      .string()
      .max(512)
      .regex(/^storage:\/\/[a-zA-Z0-9/_-]+$/)
      .optional(),
  })
  .strict();
const organizationSettingsPatchSchema = z
  .object({
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((timezone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: timezone });
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    locale: z.string().trim().min(2).max(20).optional(),
    address: z.record(z.string(), z.unknown()).optional(),
    taxInformation: z.record(z.string(), z.unknown()).optional(),
    legalName: z.string().trim().max(200).nullable().optional(),
    registrationNumber: z.string().trim().max(100).nullable().optional(),
    taxNumber: z.string().trim().max(100).nullable().optional(),
    paymentMethods: z
      .array(z.string().trim().min(1).max(50))
      .max(20)
      .optional(),
    logoUrl: z
      .union([
        z.url().startsWith("https://"),
        z
          .string()
          .max(512)
          .regex(/^storage:\/\/[a-zA-Z0-9/_-]+$/),
        z.null(),
      ])
      .optional(),
    faviconUrl: z
      .union([
        z.url().startsWith("https://"),
        z
          .string()
          .max(512)
          .regex(/^storage:\/\/[a-zA-Z0-9/_-]+$/),
        z.null(),
      ])
      .optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable()
      .optional(),
    secondaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable()
      .optional(),
    invoiceTemplate: z.string().trim().max(100).nullable().optional(),
    receiptTemplate: z.string().trim().max(100).nullable().optional(),
    emailBranding: emailBrandingSchema.optional(),
    smsSender: z.string().trim().max(20).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
const featureAssignmentPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    value: z.unknown().optional(),
    scope: z.enum(["ORGANIZATION", "BRANCH"]).default("ORGANIZATION"),
  })
  .strict()
  .refine((body) => body.enabled !== undefined || body.value !== undefined);

const settingsRead = "core.organization.settings.read";
const settingsUpdate = "core.organization.settings.update";
const featuresRead = "core.organization.features.read";
const featuresUpdate = "core.organization.features.update";

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

function sendResponse(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  response: OperationResponse,
) {
  return reply.status(response.statusCode).send(response.body);
}

function targetMatches(
  requestedOrganizationId: string,
  context: { organizationId: string },
): boolean {
  return requestedOrganizationId === context.organizationId;
}

function notFound(): OperationResponse {
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

function safeEmailBranding(value: unknown) {
  const parsed = emailBrandingSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function registerConfigurationRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  app.get(
    "/organizations/:organizationId/configuration",
    async (request, reply) => {
      const parsed = organizationPathSchema.safeParse(request.params);
      if (!parsed.success) return sendResponse(reply, notFound());

      const result = await authorization.withPermission(
        requestContext(request),
        settingsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(parsed.data.organizationId, context)) {
            return notFound();
          }
          const [organization] = await transaction
            .select({
              id: organizations.id,
              name: organizations.name,
              industry: organizations.industry,
              deploymentType: organizations.deploymentType,
            })
            .from(organizations)
            .where(eq(organizations.id, context.organizationId))
            .limit(1);
          if (!organization) return notFound();

          const [settings, business, branding] = await Promise.all([
            transaction
              .select()
              .from(organizationSettings)
              .where(
                eq(organizationSettings.organizationId, context.organizationId),
              )
              .limit(1),
            transaction
              .select()
              .from(businessSettings)
              .where(
                eq(businessSettings.organizationId, context.organizationId),
              )
              .limit(1),
            transaction
              .select()
              .from(organizationBranding)
              .where(
                eq(organizationBranding.organizationId, context.organizationId),
              )
              .limit(1),
          ]);
          return {
            statusCode: 200,
            body: {
              organization,
              capabilities: resolveConfigurationCapabilities(
                organization.deploymentType,
              ),
              settings: settings[0] ?? null,
              business: business[0] ?? null,
              branding: branding[0]
                ? {
                    ...branding[0],
                    emailBranding: safeEmailBranding(branding[0].emailBranding),
                  }
                : null,
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/configuration",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = organizationSettingsPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid organization settings.",
          },
        });
      }

      const result = await authorization.withPermission(
        requestContext(request),
        settingsUpdate,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const settingsPatch = Object.fromEntries(
            Object.entries({
              countryCode: body.data.countryCode,
              currencyCode: body.data.currencyCode,
              timezone: body.data.timezone,
              locale: body.data.locale,
              address: body.data.address,
              taxInformation: body.data.taxInformation,
            }).filter(([, value]) => value !== undefined),
          ) as Partial<typeof organizationSettings.$inferInsert>;
          const businessPatch = Object.fromEntries(
            Object.entries({
              legalName: body.data.legalName,
              registrationNumber: body.data.registrationNumber,
              taxNumber: body.data.taxNumber,
              paymentMethods: body.data.paymentMethods,
            }).filter(([, value]) => value !== undefined),
          ) as Partial<typeof businessSettings.$inferInsert>;
          const brandingPatch = Object.fromEntries(
            Object.entries({
              logoUrl: body.data.logoUrl,
              faviconUrl: body.data.faviconUrl,
              primaryColor: body.data.primaryColor,
              secondaryColor: body.data.secondaryColor,
              invoiceTemplate: body.data.invoiceTemplate,
              receiptTemplate: body.data.receiptTemplate,
              emailBranding: body.data.emailBranding,
              smsSender: body.data.smsSender,
            }).filter(([, value]) => value !== undefined),
          ) as Partial<typeof organizationBranding.$inferInsert>;

          let settings: typeof organizationSettings.$inferSelect | null = null;
          let business: typeof businessSettings.$inferSelect | null = null;
          let branding: typeof organizationBranding.$inferSelect | null = null;
          if (Object.keys(settingsPatch).length > 0) {
            const [existing] = await transaction
              .select()
              .from(organizationSettings)
              .where(
                eq(organizationSettings.organizationId, context.organizationId),
              )
              .for("update")
              .limit(1);
            let created = false;
            if (existing) {
              const [updatedSettings] = await transaction
                .update(organizationSettings)
                .set({ ...settingsPatch, updatedAt: new Date() })
                .where(
                  eq(
                    organizationSettings.organizationId,
                    context.organizationId,
                  ),
                )
                .returning();
              settings = updatedSettings ?? null;
            } else {
              const countryCode = body.data.countryCode;
              const currencyCode = body.data.currencyCode;
              const timezone = body.data.timezone;
              if (!countryCode || !currencyCode || !timezone) {
                return {
                  statusCode: 409,
                  body: {
                    error: {
                      code: "CONFLICT",
                      message:
                        "Initializing organization settings requires country, currency, and timezone.",
                    },
                  },
                };
              }
              const [createdSettings] = await transaction
                .insert(organizationSettings)
                .values({
                  organizationId: context.organizationId,
                  countryCode,
                  currencyCode,
                  timezone,
                  locale: body.data.locale ?? "en",
                  address: body.data.address ?? {},
                  taxInformation: body.data.taxInformation ?? {},
                })
                .returning();
              settings = createdSettings ?? null;
              created = true;
            }
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              created ? "CONFIGURATION_CREATED" : "CONFIGURATION_UPDATED",
              "organization_settings",
              context.organizationId,
              { fields: Object.keys(settingsPatch) },
            );
            await recordConfigurationChangedEvent(
              transaction,
              context,
              request.id,
              "organization_settings",
              context.organizationId,
              Object.keys(settingsPatch),
            );
          }

          if (Object.keys(businessPatch).length > 0) {
            const [existing] = await transaction
              .select()
              .from(businessSettings)
              .where(
                eq(businessSettings.organizationId, context.organizationId),
              )
              .for("update")
              .limit(1);
            const created = !existing;
            if (existing) {
              const [updatedBusiness] = await transaction
                .update(businessSettings)
                .set({ ...businessPatch, updatedAt: new Date() })
                .where(
                  eq(businessSettings.organizationId, context.organizationId),
                )
                .returning();
              business = updatedBusiness ?? null;
            } else {
              const [createdBusiness] = await transaction
                .insert(businessSettings)
                .values({
                  organizationId: context.organizationId,
                  legalName: body.data.legalName ?? null,
                  registrationNumber: body.data.registrationNumber ?? null,
                  taxNumber: body.data.taxNumber ?? null,
                  paymentMethods: body.data.paymentMethods ?? [],
                })
                .returning();
              business = createdBusiness ?? null;
            }
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              created ? "CONFIGURATION_CREATED" : "CONFIGURATION_UPDATED",
              "business_settings",
              context.organizationId,
              { fields: Object.keys(businessPatch) },
            );
            await recordConfigurationChangedEvent(
              transaction,
              context,
              request.id,
              "business_settings",
              context.organizationId,
              Object.keys(businessPatch),
            );
          }

          if (Object.keys(brandingPatch).length > 0) {
            const [existing] = await transaction
              .select()
              .from(organizationBranding)
              .where(
                eq(organizationBranding.organizationId, context.organizationId),
              )
              .for("update")
              .limit(1);
            const created = !existing;
            if (existing) {
              const [updatedBranding] = await transaction
                .update(organizationBranding)
                .set({ ...brandingPatch, updatedAt: new Date() })
                .where(
                  eq(
                    organizationBranding.organizationId,
                    context.organizationId,
                  ),
                )
                .returning();
              branding = updatedBranding ?? null;
            } else {
              const [createdBranding] = await transaction
                .insert(organizationBranding)
                .values({
                  organizationId: context.organizationId,
                  ...brandingPatch,
                })
                .returning();
              branding = createdBranding ?? null;
            }
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              created ? "CONFIGURATION_CREATED" : "CONFIGURATION_UPDATED",
              "organization_branding",
              context.organizationId,
              { fields: Object.keys(brandingPatch) },
            );
            await recordConfigurationChangedEvent(
              transaction,
              context,
              request.id,
              "organization_branding",
              context.organizationId,
              Object.keys(brandingPatch),
            );
          }
          return { statusCode: 200, body: { settings, business, branding } };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get("/organizations/:organizationId/features", async (request, reply) => {
    const parsed = organizationPathSchema.safeParse(request.params);
    if (!parsed.success) return sendResponse(reply, notFound());

    const result = await authorization.withPermission(
      requestContext(request),
      featuresRead,
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(parsed.data.organizationId, context)) {
          return notFound();
        }
        const definitions = await transaction
          .select({
            id: featureFlags.id,
            name: featureFlags.key,
            description: featureFlags.description,
            valueType: featureFlags.valueType,
            defaultValue: featureFlags.defaultValue,
            isSecuritySensitive: featureFlags.isSecuritySensitive,
          })
          .from(featureFlags)
          .orderBy(asc(featureFlags.key));
        const assignmentRows = await transaction
          .select({
            flagId: featureFlagAssignments.flagId,
            scope: featureFlagAssignments.scopeKey,
            enabled: featureFlagAssignments.enabled,
            value: featureFlagAssignments.value,
            environment: featureFlagAssignments.environment,
            moduleId: featureFlagAssignments.moduleId,
            organizationId: featureFlagAssignments.organizationId,
            branchId: featureFlagAssignments.branchId,
            userId: featureFlagAssignments.userId,
          })
          .from(featureFlagAssignments)
          .where(
            inArray(featureFlagAssignments.scopeKey, [
              "SYSTEM",
              "PLATFORM",
              "GLOBAL",
              "ENVIRONMENT",
              "MODULE",
              "ORGANIZATION",
              "BRANCH",
              "USER",
            ]),
          );
        const assignmentsByFlag = new Map<string, FeatureFlagValue[]>();
        for (const assignment of assignmentRows) {
          const values = assignmentsByFlag.get(assignment.flagId) ?? [];
          values.push(assignment);
          assignmentsByFlag.set(assignment.flagId, values);
        }
        const features = definitions.map((definition) => ({
          name: definition.name,
          description: definition.description,
          value: resolveFeatureFlag(
            {
              key: definition.name,
              valueType: definition.valueType,
              defaultValue: definition.defaultValue,
              isSecuritySensitive: definition.isSecuritySensitive,
            },
            assignmentsByFlag.get(definition.id) ?? [],
            {
              authenticated: true,
              organizationId: context.organizationId,
              userId: context.userId,
              ...(context.branch ? { branchId: context.branch.branchId } : {}),
              organizationActive: true,
              membershipActive: true,
              moduleEntitlements: new Map(),
              platformAuthorized: false,
            },
          ),
          ...(definition.valueType === "BOOLEAN"
            ? {
                enabled: resolveFeatureFlag(
                  {
                    key: definition.name,
                    valueType: definition.valueType,
                    defaultValue: definition.defaultValue,
                    isSecuritySensitive: definition.isSecuritySensitive,
                  },
                  assignmentsByFlag.get(definition.id) ?? [],
                  {
                    authenticated: true,
                    organizationId: context.organizationId,
                    userId: context.userId,
                    ...(context.branch
                      ? { branchId: context.branch.branchId }
                      : {}),
                    organizationActive: true,
                    membershipActive: true,
                    moduleEntitlements: new Map(),
                    platformAuthorized: false,
                  },
                ) as boolean,
              }
            : {}),
        }));
        return { statusCode: 200, body: { features } };
      },
    );
    if (!result.allowed) return denied(reply, result.statusCode);
    return sendResponse(reply, result.value);
  });

  app.get(
    "/organizations/:organizationId/features/:flagName",
    async (request, reply) => {
      const path = featurePathSchema.safeParse(request.params);
      const query = featureResolutionQuerySchema.safeParse(request.query);
      if (!path.success || !query.success)
        return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        featuresRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [definition] = await transaction
            .select({
              id: featureFlags.id,
              key: featureFlags.key,
              description: featureFlags.description,
              valueType: featureFlags.valueType,
              defaultValue: featureFlags.defaultValue,
              isSecuritySensitive: featureFlags.isSecuritySensitive,
            })
            .from(featureFlags)
            .where(eq(featureFlags.key, path.data.flagName))
            .limit(1);
          if (!definition) return notFound();
          const assignmentRows = await transaction
            .select({
              scope: featureFlagAssignments.scopeKey,
              enabled: featureFlagAssignments.enabled,
              value: featureFlagAssignments.value,
              environment: featureFlagAssignments.environment,
              moduleId: featureFlagAssignments.moduleId,
              organizationId: featureFlagAssignments.organizationId,
              branchId: featureFlagAssignments.branchId,
              userId: featureFlagAssignments.userId,
            })
            .from(featureFlagAssignments)
            .where(eq(featureFlagAssignments.flagId, definition.id));

          let moduleId: string | undefined;
          const moduleEntitlements = new Map<string, boolean>();
          let moduleAvailable: boolean | undefined;
          if (query.data.moduleKey) {
            const [module] = await transaction
              .select({ id: modules.id, key: modules.key })
              .from(modules)
              .where(eq(modules.key, query.data.moduleKey))
              .limit(1);
            if (!module) return notFound();
            moduleId = module.id;
            const moduleAccess = await loadOrganizationModuleAccess(
              transaction,
              context.organizationId,
            );
            moduleAvailable = moduleAccess.get(module.key)?.allowed === true;
            moduleEntitlements.set(module.id, moduleAvailable);
          }

          const value = resolveFeatureFlag(
            {
              key: definition.key,
              valueType: definition.valueType,
              defaultValue: definition.defaultValue,
              isSecuritySensitive: definition.isSecuritySensitive,
            },
            assignmentRows,
            {
              authenticated: true,
              organizationId: context.organizationId,
              userId: context.userId,
              ...(context.branch ? { branchId: context.branch.branchId } : {}),
              ...(moduleId ? { moduleId } : {}),
              ...(process.env.NODE_ENV
                ? { environment: process.env.NODE_ENV }
                : {}),
              organizationActive: true,
              membershipActive: true,
              moduleEntitlements,
              platformAuthorized: false,
            },
          );
          return {
            statusCode: 200,
            body: {
              feature: {
                key: definition.key,
                description: definition.description,
                value,
                ...(definition.valueType === "BOOLEAN"
                  ? { enabled: value as boolean }
                  : {}),
              },
              ...(moduleAvailable === undefined ? {} : { moduleAvailable }),
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/features/:flagName",
    async (request, reply) => {
      const path = featurePathSchema.safeParse(request.params);
      const body = featureAssignmentPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid feature assignment.",
          },
        });
      }

      const result = await authorization.withPermission(
        requestContext(request),
        featuresUpdate,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [flag] = await transaction
            .select({
              id: featureFlags.id,
              valueType: featureFlags.valueType,
              isSecuritySensitive: featureFlags.isSecuritySensitive,
            })
            .from(featureFlags)
            .where(eq(featureFlags.key, path.data.flagName))
            .limit(1);
          if (!flag) return notFound();
          if (flag.isSecuritySensitive) {
            return {
              statusCode: 403,
              body: {
                error: {
                  code: "FORBIDDEN",
                  message:
                    "Security-sensitive flags cannot be changed by an organization.",
                },
              },
            };
          }

          let value: unknown;
          try {
            value = parseFeatureFlagValue(
              flag.valueType,
              body.data.value === undefined
                ? body.data.enabled
                : body.data.value,
            );
          } catch {
            return {
              statusCode: 400,
              body: {
                error: {
                  code: "BAD_REQUEST",
                  message:
                    "The feature value does not match its declared type.",
                },
              },
            };
          }
          const branchId =
            body.data.scope === "BRANCH" ? context.branch?.branchId : null;
          if (body.data.scope === "BRANCH" && !branchId) {
            return {
              statusCode: 403,
              body: {
                error: {
                  code: "FORBIDDEN",
                  message: "A verified branch context is required.",
                },
              },
            };
          }
          const legacyScope =
            body.data.scope === "BRANCH" ? "ORGANIZATION" : body.data.scope;

          const [existing] = await transaction
            .select({ id: featureFlagAssignments.id })
            .from(featureFlagAssignments)
            .where(
              and(
                eq(featureFlagAssignments.flagId, flag.id),
                eq(featureFlagAssignments.scopeKey, body.data.scope),
                eq(
                  featureFlagAssignments.organizationId,
                  context.organizationId,
                ),
                body.data.scope === "BRANCH"
                  ? eq(featureFlagAssignments.branchId, branchId!)
                  : isNull(featureFlagAssignments.branchId),
              ),
            )
            .limit(1);
          if (existing) {
            await transaction
              .update(featureFlagAssignments)
              .set({
                enabled: typeof value === "boolean" ? value : false,
                value,
              })
              .where(eq(featureFlagAssignments.id, existing.id));
          } else {
            await transaction.insert(featureFlagAssignments).values({
              flagId: flag.id,
              scope: legacyScope,
              scopeKey: body.data.scope,
              organizationId: context.organizationId,
              branchId,
              enabled: typeof value === "boolean" ? value : false,
              value,
            });
          }
          const auditAction =
            typeof value !== "boolean"
              ? "FEATURE_FLAG_UPDATED"
              : value
                ? "FEATURE_FLAG_ENABLED"
                : "FEATURE_FLAG_DISABLED";
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            auditAction,
            "feature_flag",
            path.data.flagName,
            { scope: body.data.scope },
          );
          await recordFeatureFlagChangedEvent(
            transaction,
            context,
            request.id,
            path.data.flagName,
            flag.valueType,
            body.data.scope,
            flag.id,
          );
          return {
            statusCode: 200,
            body: { name: path.data.flagName, value, scope: body.data.scope },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );
}
