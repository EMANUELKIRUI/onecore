import {
  type AuthorizationContext,
  type AuthorizationService,
  type OrganizationTransaction,
  communicationDeliveries,
  communicationDeliveryAttempts,
  communicationMessages,
  communicationProviderConfigs,
  communicationTemplateVersions,
  communicationTemplates,
  createCommunicationService,
  createPlatformServices,
  integrations,
  notificationPreferences,
  organizationMemberships,
  writeAuthorizationMutationEvent,
} from "@onecore/database";
import {
  communicationChannelSchema,
  communicationTemplateInputSchema,
  createPermissionKey,
  queueCommunicationInputSchema,
  type CommunicationChannel,
} from "@onecore/core-domain";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import { recordConfigurationChangedEvent } from "./event-publication.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const templatePathSchema = organizationPathSchema.extend({
  templateId: z.uuid(),
});
const templateVersionPathSchema = templatePathSchema.extend({
  versionId: z.uuid(),
});
const deliveryPathSchema = organizationPathSchema.extend({
  deliveryId: z.uuid(),
});
const providerConfigPathSchema = organizationPathSchema.extend({
  providerConfigId: z.uuid(),
});
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .transform((locale, context) => {
    try {
      return (
        Intl.getCanonicalLocales(locale)[0] ??
        context.addIssue({
          code: "custom",
          message: "Invalid locale",
        })
      );
    } catch {
      context.addIssue({ code: "custom", message: "Invalid locale" });
    }
  });
const preferenceItemSchema = z
  .object({
    channel: communicationChannelSchema,
    category: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
    enabled: z.boolean(),
  })
  .strict();
const preferenceDefaultsSchema = z
  .object({ preferences: z.array(preferenceItemSchema).max(100) })
  .strict()
  .refine(
    ({ preferences }) =>
      new Set(
        preferences.map(({ channel, category }) => `${channel}:${category}`),
      ).size === preferences.length,
  );
const userPreferencePatchSchema = z
  .object({
    channel: communicationChannelSchema.optional(),
    category: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
      .optional(),
    enabled: z.boolean().optional(),
    locale: localeSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.locale !== undefined ||
      (value.channel !== undefined &&
        value.category !== undefined &&
        value.enabled !== undefined),
  );
const templateCreateSchema = communicationTemplateInputSchema;
const providerConfigurationSchema = z
  .object({
    senderName: z.string().trim().min(1).max(120).optional(),
    senderAddress: z.string().trim().min(3).max(320).optional(),
    replyTo: z.email().max(320).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    environment: z.enum(["TEST", "LIVE"]).optional(),
    accountReference: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
const providerConfigCreateSchema = z
  .object({
    integrationId: z.uuid(),
    channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
    providerKey: z
      .string()
      .trim()
      .min(3)
      .max(80)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    configuration: providerConfigurationSchema.default({}),
  })
  .strict();
const providerConfigPatchSchema = z
  .object({
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    configuration: providerConfigurationSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);

function integrationProviderForChannel(channel: "EMAIL" | "SMS" | "WHATSAPP") {
  switch (channel) {
    case "EMAIL":
      return "EMAIL_PROVIDER";
    case "SMS":
      return "SMS_PROVIDER";
    case "WHATSAPP":
      return "WHATSAPP_PROVIDER";
  }
}

function publicProviderConfig<T extends { secretReference: string | null }>(
  config: T,
) {
  const { secretReference, ...metadata } = config;
  return { ...metadata, hasCredentials: secretReference !== null };
}

const permission = {
  notificationsRead: createPermissionKey(
    "core.organization",
    "notifications",
    "read",
  ),
  notificationsManage: createPermissionKey(
    "core.organization",
    "notifications",
    "manage",
  ),
  inboxRead: createPermissionKey(
    "core.organization",
    "notification_inbox",
    "read",
  ),
  inboxSelfUpdate: createPermissionKey(
    "core.organization",
    "notification_inbox",
    "update_self",
  ),
  preferencesSelfRead: createPermissionKey(
    "core.organization",
    "notification_preferences",
    "read_self",
  ),
  preferencesSelfUpdate: createPermissionKey(
    "core.organization",
    "notification_preferences",
    "update_self",
  ),
  integrationsRead: createPermissionKey(
    "core.organization",
    "integrations",
    "read",
  ),
  integrationsManage: createPermissionKey(
    "core.organization",
    "integrations",
    "manage",
  ),
} as const;

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: FastifyRequest): AuthorizationContext | null {
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

function sendDenied(reply: FastifyReply, statusCode: 401 | 403) {
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

function sendResponse(reply: FastifyReply, result: OperationResponse) {
  return reply.status(result.statusCode).send(result.body);
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

function targetMatches(
  organizationId: string,
  context: { organizationId: string },
) {
  return organizationId === context.organizationId;
}

function response(statusCode: number, body: unknown): OperationResponse {
  return { statusCode, body };
}

function safeTemplateVersion<T extends { variables: string[] }>(version: T) {
  return { ...version, variables: [...version.variables] };
}

async function auditConfigurationChange(
  transaction: OrganizationTransaction,
  context: Parameters<Parameters<AuthorizationService["withPermission"]>[3]>[1],
  requestId: string,
  resource: string,
  resourceId: string,
  action: string,
  changedFields: string[],
  details: Record<string, unknown> = {},
): Promise<void> {
  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    action,
    resource,
    resourceId,
    details,
  );
  await recordConfigurationChangedEvent(
    transaction,
    context,
    requestId,
    resource,
    resourceId,
    changedFields,
  );
}

async function writePreference(
  transaction: OrganizationTransaction,
  input: {
    organizationId: string;
    userId: string | null;
    channel: CommunicationChannel;
    category: string;
    enabled: boolean;
  },
): Promise<void> {
  const userPredicate =
    input.userId === null
      ? isNull(notificationPreferences.userId)
      : eq(notificationPreferences.userId, input.userId);
  const where = and(
    eq(notificationPreferences.organizationId, input.organizationId),
    userPredicate,
    eq(notificationPreferences.channel, input.channel),
    eq(notificationPreferences.category, input.category),
  );
  const [existing] = await transaction
    .select({ id: notificationPreferences.id })
    .from(notificationPreferences)
    .where(where)
    .for("update")
    .limit(1);
  if (existing) {
    await transaction
      .update(notificationPreferences)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(eq(notificationPreferences.id, existing.id));
    return;
  }
  const inserted = await transaction
    .insert(notificationPreferences)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: notificationPreferences.id });
  if (!inserted.length) {
    await transaction
      .update(notificationPreferences)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(where);
  }
}

export function registerCommunicationRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService,
): void {
  const communicationService = createCommunicationService(authorization);
  const platformServices = createPlatformServices(authorization);

  app.get(
    "/organizations/:organizationId/communication-templates",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!path.success || !query.success)
        return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        permission.notificationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const templates = await transaction
            .select()
            .from(communicationTemplates)
            .where(
              eq(communicationTemplates.organizationId, context.organizationId),
            )
            .orderBy(asc(communicationTemplates.key))
            .limit(query.data.limit)
            .offset(query.data.offset);
          const templateIds = templates.map(({ id }) => id);
          const versions = templateIds.length
            ? await transaction
                .select()
                .from(communicationTemplateVersions)
                .where(
                  and(
                    eq(
                      communicationTemplateVersions.organizationId,
                      context.organizationId,
                    ),
                    inArray(
                      communicationTemplateVersions.templateId,
                      templateIds,
                    ),
                  ),
                )
                .orderBy(
                  desc(communicationTemplateVersions.version),
                  asc(communicationTemplateVersions.locale),
                )
            : [];
          return response(200, {
            templates: templates.map((template) => ({
              ...template,
              versions: versions
                .filter((version) => version.templateId === template.id)
                .map(safeTemplateVersion),
            })),
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/communication-templates",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = templateCreateSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid communication template.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        permission.notificationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const [template] = await transaction
            .insert(communicationTemplates)
            .values({
              organizationId: context.organizationId,
              key: body.data.key,
              channel: body.data.channel,
            })
            .onConflictDoNothing()
            .returning();
          if (!template) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "That template key already exists.",
              },
            });
          }
          const [version] = await transaction
            .insert(communicationTemplateVersions)
            .values({
              organizationId: context.organizationId,
              templateId: template.id,
              version: 1,
              locale: body.data.locale,
              subject: body.data.subject ?? null,
              body: body.data.body,
              variables: body.data.variables,
            })
            .returning();
          if (!version)
            throw new Error("COMMUNICATION_TEMPLATE_VERSION_CREATE_FAILED");
          await auditConfigurationChange(
            transaction,
            context,
            request.id,
            "communication_template",
            template.id,
            "COMMUNICATION_TEMPLATE_CREATED",
            ["created", "channel", "locale"],
            { key: template.key, version: version.version },
          );
          return response(201, {
            template,
            version: safeTemplateVersion(version),
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/communication-templates/:templateId/versions",
    async (request, reply) => {
      const path = templatePathSchema.safeParse(request.params);
      const body = communicationTemplateInputSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid template version.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        permission.notificationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const [template] = await transaction
            .select()
            .from(communicationTemplates)
            .where(
              and(
                eq(
                  communicationTemplates.organizationId,
                  context.organizationId,
                ),
                eq(communicationTemplates.id, path.data.templateId),
                eq(communicationTemplates.channel, body.data.channel),
              ),
            )
            .limit(1);
          if (!template) return notFound();
          const [latest] = await transaction
            .select({ version: communicationTemplateVersions.version })
            .from(communicationTemplateVersions)
            .where(
              and(
                eq(
                  communicationTemplateVersions.organizationId,
                  context.organizationId,
                ),
                eq(communicationTemplateVersions.templateId, template.id),
                eq(communicationTemplateVersions.locale, body.data.locale),
              ),
            )
            .orderBy(desc(communicationTemplateVersions.version))
            .limit(1);
          const [version] = await transaction
            .insert(communicationTemplateVersions)
            .values({
              organizationId: context.organizationId,
              templateId: template.id,
              version: (latest?.version ?? 0) + 1,
              locale: body.data.locale,
              subject: body.data.subject ?? null,
              body: body.data.body,
              variables: body.data.variables,
            })
            .returning();
          if (!version)
            throw new Error("COMMUNICATION_TEMPLATE_VERSION_CREATE_FAILED");
          await auditConfigurationChange(
            transaction,
            context,
            request.id,
            "communication_template_version",
            version.id,
            "COMMUNICATION_TEMPLATE_DRAFT_CREATED",
            ["created", "locale", "body", "variables"],
            { templateId: template.id, version: version.version },
          );
          return response(201, { version: safeTemplateVersion(version) });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/communication-templates/:templateId/versions/:versionId",
    async (request, reply) => {
      const path = templateVersionPathSchema.safeParse(request.params);
      const body = communicationTemplateInputSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid template draft." },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        permission.notificationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const [version] = await transaction
            .update(communicationTemplateVersions)
            .set({
              locale: body.data.locale,
              subject: body.data.subject ?? null,
              body: body.data.body,
              variables: body.data.variables,
            })
            .where(
              and(
                eq(
                  communicationTemplateVersions.organizationId,
                  context.organizationId,
                ),
                eq(
                  communicationTemplateVersions.templateId,
                  path.data.templateId,
                ),
                eq(communicationTemplateVersions.id, path.data.versionId),
                eq(communicationTemplateVersions.status, "DRAFT"),
              ),
            )
            .returning();
          if (!version) return notFound();
          await auditConfigurationChange(
            transaction,
            context,
            request.id,
            "communication_template_version",
            version.id,
            "COMMUNICATION_TEMPLATE_DRAFT_UPDATED",
            ["locale", "body", "variables"],
            { templateId: version.templateId, version: version.version },
          );
          return response(200, { version: safeTemplateVersion(version) });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/communication-templates/:templateId/versions/:versionId/publish",
    async (request, reply) => {
      const path = templateVersionPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        permission.notificationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const [draft] = await transaction
            .select()
            .from(communicationTemplateVersions)
            .where(
              and(
                eq(
                  communicationTemplateVersions.organizationId,
                  context.organizationId,
                ),
                eq(
                  communicationTemplateVersions.templateId,
                  path.data.templateId,
                ),
                eq(communicationTemplateVersions.id, path.data.versionId),
                eq(communicationTemplateVersions.status, "DRAFT"),
              ),
            )
            .for("update")
            .limit(1);
          if (!draft) return notFound();
          await transaction
            .update(communicationTemplateVersions)
            .set({ status: "RETIRED" })
            .where(
              and(
                eq(
                  communicationTemplateVersions.organizationId,
                  context.organizationId,
                ),
                eq(communicationTemplateVersions.templateId, draft.templateId),
                eq(communicationTemplateVersions.locale, draft.locale),
                eq(communicationTemplateVersions.status, "PUBLISHED"),
              ),
            );
          const [published] = await transaction
            .update(communicationTemplateVersions)
            .set({ status: "PUBLISHED", publishedAt: new Date() })
            .where(
              and(
                eq(
                  communicationTemplateVersions.organizationId,
                  context.organizationId,
                ),
                eq(communicationTemplateVersions.id, draft.id),
                eq(communicationTemplateVersions.status, "DRAFT"),
              ),
            )
            .returning();
          if (!published) return notFound();
          await auditConfigurationChange(
            transaction,
            context,
            request.id,
            "communication_template_version",
            published.id,
            "COMMUNICATION_TEMPLATE_PUBLISHED",
            ["status", "publishedAt"],
            {
              templateId: published.templateId,
              version: published.version,
              locale: published.locale,
            },
          );
          return response(200, { version: safeTemplateVersion(published) });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/notification-preferences",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        permission.preferencesSelfRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const preferences = await transaction
            .select({
              channel: notificationPreferences.channel,
              category: notificationPreferences.category,
              enabled: notificationPreferences.enabled,
              updatedAt: notificationPreferences.updatedAt,
            })
            .from(notificationPreferences)
            .where(
              and(
                eq(
                  notificationPreferences.organizationId,
                  context.organizationId,
                ),
                eq(notificationPreferences.userId, context.userId),
              ),
            )
            .orderBy(
              asc(notificationPreferences.channel),
              asc(notificationPreferences.category),
            );
          const [membership] = await transaction
            .select({ locale: organizationMemberships.locale })
            .from(organizationMemberships)
            .where(
              and(
                eq(
                  organizationMemberships.organizationId,
                  context.organizationId,
                ),
                eq(organizationMemberships.userId, context.userId),
                eq(organizationMemberships.status, "ACTIVE"),
              ),
            )
            .limit(1);
          return response(200, {
            preferences,
            locale: membership?.locale ?? null,
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.put(
    "/organizations/:organizationId/notification-preferences",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = userPreferencePatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid notification preference.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        permission.preferencesSelfUpdate,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          if (
            body.data.channel !== undefined &&
            body.data.category !== undefined &&
            body.data.enabled !== undefined
          ) {
            await writePreference(transaction, {
              organizationId: context.organizationId,
              userId: context.userId,
              channel: body.data.channel,
              category: body.data.category,
              enabled: body.data.enabled,
            });
          }
          if (body.data.locale !== undefined) {
            await transaction
              .update(organizationMemberships)
              .set({ locale: body.data.locale, updatedAt: new Date() })
              .where(
                and(
                  eq(
                    organizationMemberships.organizationId,
                    context.organizationId,
                  ),
                  eq(organizationMemberships.userId, context.userId),
                  eq(organizationMemberships.status, "ACTIVE"),
                ),
              );
          }
          await auditConfigurationChange(
            transaction,
            context,
            request.id,
            "notification_preference",
            context.userId,
            "NOTIFICATION_PREFERENCE_UPDATED",
            [
              ...(body.data.channel ? ["channel"] : []),
              ...(body.data.category ? ["category"] : []),
              ...(body.data.enabled !== undefined ? ["enabled"] : []),
              ...(body.data.locale ? ["locale"] : []),
            ],
            { userId: context.userId },
          );
          return response(200, { updated: true });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/notification-preferences/defaults",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        permission.notificationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const preferences = await transaction
            .select({
              channel: notificationPreferences.channel,
              category: notificationPreferences.category,
              enabled: notificationPreferences.enabled,
              updatedAt: notificationPreferences.updatedAt,
            })
            .from(notificationPreferences)
            .where(
              and(
                eq(
                  notificationPreferences.organizationId,
                  context.organizationId,
                ),
                isNull(notificationPreferences.userId),
              ),
            )
            .orderBy(
              asc(notificationPreferences.channel),
              asc(notificationPreferences.category),
            );
          return response(200, { preferences });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.put(
    "/organizations/:organizationId/notification-preferences/defaults",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = preferenceDefaultsSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid organization notification preferences.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        permission.notificationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          await transaction
            .delete(notificationPreferences)
            .where(
              and(
                eq(
                  notificationPreferences.organizationId,
                  context.organizationId,
                ),
                isNull(notificationPreferences.userId),
              ),
            );
          for (const item of body.data.preferences) {
            await transaction.insert(notificationPreferences).values({
              organizationId: context.organizationId,
              userId: null,
              ...item,
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "ORGANIZATION_NOTIFICATION_DEFAULTS_UPDATED",
            "notification_preference",
            context.organizationId,
            { preferenceCount: body.data.preferences.length },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "notification_preference",
            context.organizationId,
            ["organizationDefaults"],
          );
          return response(200, { updated: body.data.preferences.length });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/communication-providers",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        permission.integrationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const configs = await transaction
            .select({
              id: communicationProviderConfigs.id,
              integrationId: communicationProviderConfigs.integrationId,
              channel: communicationProviderConfigs.channel,
              providerKey: communicationProviderConfigs.providerKey,
              status: communicationProviderConfigs.status,
              configuration: communicationProviderConfigs.configuration,
              secretReference: integrations.secretReference,
              createdAt: communicationProviderConfigs.createdAt,
              updatedAt: communicationProviderConfigs.updatedAt,
            })
            .from(communicationProviderConfigs)
            .innerJoin(
              integrations,
              and(
                eq(
                  integrations.organizationId,
                  communicationProviderConfigs.organizationId,
                ),
                eq(integrations.id, communicationProviderConfigs.integrationId),
              ),
            )
            .where(
              eq(
                communicationProviderConfigs.organizationId,
                context.organizationId,
              ),
            )
            .orderBy(asc(communicationProviderConfigs.channel));
          return response(200, {
            providers: configs.map(publicProviderConfig),
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/communication-providers",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = providerConfigCreateSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid provider configuration metadata.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        permission.integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const [integration] = await transaction
            .select({
              id: integrations.id,
              provider: integrations.provider,
              secretReference: integrations.secretReference,
            })
            .from(integrations)
            .where(
              and(
                eq(integrations.organizationId, context.organizationId),
                eq(integrations.id, body.data.integrationId),
              ),
            )
            .limit(1);
          if (
            !integration ||
            integration.provider !==
              integrationProviderForChannel(body.data.channel)
          ) {
            return notFound();
          }
          const [created] = await transaction
            .insert(communicationProviderConfigs)
            .values({
              organizationId: context.organizationId,
              integrationId: integration.id,
              channel: body.data.channel,
              providerKey: body.data.providerKey,
              configuration: body.data.configuration,
              status: "DISABLED",
            })
            .onConflictDoNothing()
            .returning({
              id: communicationProviderConfigs.id,
              integrationId: communicationProviderConfigs.integrationId,
              channel: communicationProviderConfigs.channel,
              providerKey: communicationProviderConfigs.providerKey,
              status: communicationProviderConfigs.status,
              configuration: communicationProviderConfigs.configuration,
              createdAt: communicationProviderConfigs.createdAt,
              updatedAt: communicationProviderConfigs.updatedAt,
            });
          if (!created) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "A provider configuration already exists.",
              },
            });
          }
          await auditConfigurationChange(
            transaction,
            context,
            request.id,
            "communication_provider_config",
            created.id,
            "COMMUNICATION_PROVIDER_CONFIG_CREATED",
            ["created", "channel", "providerKey"],
            {
              integrationId: integration.id,
              channel: created.channel,
              providerKey: created.providerKey,
            },
          );
          return response(201, {
            provider: {
              ...created,
              hasCredentials: integration.secretReference !== null,
            },
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/communication-providers/:providerConfigId",
    async (request, reply) => {
      const path = providerConfigPathSchema.safeParse(request.params);
      const body = providerConfigPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid provider configuration update.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        permission.integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const [current] = await transaction
            .select({
              id: communicationProviderConfigs.id,
              integrationId: communicationProviderConfigs.integrationId,
              channel: communicationProviderConfigs.channel,
              providerKey: communicationProviderConfigs.providerKey,
              secretReference: integrations.secretReference,
            })
            .from(communicationProviderConfigs)
            .innerJoin(
              integrations,
              and(
                eq(
                  integrations.organizationId,
                  communicationProviderConfigs.organizationId,
                ),
                eq(integrations.id, communicationProviderConfigs.integrationId),
              ),
            )
            .where(
              and(
                eq(
                  communicationProviderConfigs.organizationId,
                  context.organizationId,
                ),
                eq(communicationProviderConfigs.id, path.data.providerConfigId),
              ),
            )
            .for("update")
            .limit(1);
          if (!current) return notFound();
          if (body.data.status === "ACTIVE" && !current.secretReference) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message:
                  "Configure an integration credential before enabling this provider.",
              },
            });
          }
          const [updated] = await transaction
            .update(communicationProviderConfigs)
            .set({ ...body.data, updatedAt: new Date() })
            .where(
              and(
                eq(
                  communicationProviderConfigs.organizationId,
                  context.organizationId,
                ),
                eq(communicationProviderConfigs.id, current.id),
              ),
            )
            .returning({
              id: communicationProviderConfigs.id,
              integrationId: communicationProviderConfigs.integrationId,
              channel: communicationProviderConfigs.channel,
              providerKey: communicationProviderConfigs.providerKey,
              status: communicationProviderConfigs.status,
              configuration: communicationProviderConfigs.configuration,
              createdAt: communicationProviderConfigs.createdAt,
              updatedAt: communicationProviderConfigs.updatedAt,
            });
          if (!updated) return notFound();
          await auditConfigurationChange(
            transaction,
            context,
            request.id,
            "communication_provider_config",
            updated.id,
            "COMMUNICATION_PROVIDER_CONFIG_UPDATED",
            Object.keys(body.data),
            { channel: updated.channel, providerKey: updated.providerKey },
          );
          return response(200, {
            provider: {
              ...updated,
              hasCredentials: current.secretReference !== null,
            },
          });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/communications",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = queueCommunicationInputSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid communication request.",
          },
        });
      }
      const authContext = requestContext(request);
      if (
        !authContext ||
        authContext.organizationId !== path.data.organizationId
      ) {
        return sendDenied(reply, authContext ? 403 : 401);
      }
      const queued = await communicationService.enqueue(
        authContext,
        { requestId: request.id },
        body.data,
      );
      if (!queued.allowed) return sendDenied(reply, queued.statusCode);
      const statusCode =
        queued.value.outcome === "QUEUED" && queued.value.status === "QUEUED"
          ? 202
          : 200;
      return reply.status(statusCode).send({ communication: queued.value });
    },
  );

  app.get(
    "/organizations/:organizationId/communications/deliveries",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!path.success || !query.success)
        return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        permission.inboxRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const deliveries = await transaction
            .select({
              deliveryId: communicationDeliveries.id,
              messageId: communicationMessages.id,
              channel: communicationMessages.channel,
              category: communicationMessages.category,
              status: communicationDeliveries.status,
              attemptCount: communicationDeliveries.attemptCount,
              maxAttempts: communicationDeliveries.maxAttempts,
              nextAttemptAt: communicationDeliveries.nextAttemptAt,
              lastFailureClass: communicationDeliveries.lastFailureClass,
              lastFailureCode: communicationDeliveries.lastFailureCode,
              createdAt: communicationDeliveries.createdAt,
              completedAt: communicationDeliveries.completedAt,
            })
            .from(communicationDeliveries)
            .innerJoin(
              communicationMessages,
              and(
                eq(
                  communicationMessages.organizationId,
                  communicationDeliveries.organizationId,
                ),
                eq(communicationMessages.id, communicationDeliveries.messageId),
              ),
            )
            .where(
              and(
                eq(
                  communicationDeliveries.organizationId,
                  context.organizationId,
                ),
                eq(communicationMessages.recipientUserId, context.userId),
              ),
            )
            .orderBy(desc(communicationDeliveries.createdAt))
            .limit(query.data.limit)
            .offset(query.data.offset);
          return response(200, { deliveries });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/communications/deliveries/:deliveryId/attempts",
    async (request, reply) => {
      const path = deliveryPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        permission.inboxRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const [delivery] = await transaction
            .select({ id: communicationDeliveries.id })
            .from(communicationDeliveries)
            .innerJoin(
              communicationMessages,
              and(
                eq(
                  communicationMessages.organizationId,
                  communicationDeliveries.organizationId,
                ),
                eq(communicationMessages.id, communicationDeliveries.messageId),
              ),
            )
            .where(
              and(
                eq(
                  communicationDeliveries.organizationId,
                  context.organizationId,
                ),
                eq(communicationDeliveries.id, path.data.deliveryId),
                eq(communicationMessages.recipientUserId, context.userId),
              ),
            )
            .limit(1);
          if (!delivery) return notFound();
          const attempts = await transaction
            .select({
              attemptNumber: communicationDeliveryAttempts.attemptNumber,
              status: communicationDeliveryAttempts.status,
              providerMessageId:
                communicationDeliveryAttempts.providerMessageId,
              failureClass: communicationDeliveryAttempts.failureClass,
              failureCode: communicationDeliveryAttempts.failureCode,
              retryAfterSeconds:
                communicationDeliveryAttempts.retryAfterSeconds,
              createdAt: communicationDeliveryAttempts.createdAt,
              completedAt: communicationDeliveryAttempts.completedAt,
            })
            .from(communicationDeliveryAttempts)
            .where(
              and(
                eq(
                  communicationDeliveryAttempts.organizationId,
                  context.organizationId,
                ),
                eq(communicationDeliveryAttempts.deliveryId, delivery.id),
              ),
            )
            .orderBy(asc(communicationDeliveryAttempts.attemptNumber));
          return response(200, { attempts });
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/notifications",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!path.success || !query.success)
        return sendResponse(reply, notFound());
      const authContext = requestContext(request);
      if (!authContext) return sendDenied(reply, 401);
      if (authContext.organizationId !== path.data.organizationId) {
        return sendResponse(reply, notFound());
      }
      const result = await platformServices.listNotifications(
        authContext,
        { requestId: request.id },
        query.data,
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      if (!targetMatches(path.data.organizationId, result.context))
        return sendResponse(reply, notFound());
      return reply.send({ notifications: result.value });
    },
  );

  app.post(
    "/organizations/:organizationId/notifications/:notificationId/read",
    async (request, reply) => {
      const path = organizationPathSchema
        .extend({ notificationId: z.uuid() })
        .safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const authContext = requestContext(request);
      if (
        !authContext ||
        authContext.organizationId !== path.data.organizationId
      ) {
        return sendDenied(reply, authContext ? 403 : 401);
      }
      const result = await platformServices.setNotificationReadState(
        authContext,
        { requestId: request.id },
        path.data.notificationId,
        true,
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return result.value
        ? reply.status(204).send()
        : sendResponse(reply, notFound());
    },
  );
}
