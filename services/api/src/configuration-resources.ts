import { domainToASCII } from "node:url";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  customDomains,
  customFieldDefinitions,
  integrations,
  notificationConfigurations,
  workflowActions,
  workflowConditions,
  workflowDefinitions,
  workflowTransitions,
  workflowVersions,
  writeAuthorizationMutationEvent,
  workflowSteps,
  workflowTriggers,
  type AuthorizationContext,
  type AuthorizationService,
  denyAllAuthorizationService,
} from "@onecore/database";
import { customFieldTypes, parseCustomFieldValue } from "@onecore/core-domain";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import { recordConfigurationChangedEvent } from "./event-publication.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const fieldPathSchema = organizationPathSchema.extend({ fieldId: z.uuid() });
const workflowPathSchema = organizationPathSchema.extend({
  workflowId: z.uuid(),
});
const workflowVersionPathSchema = workflowPathSchema.extend({
  versionId: z.uuid(),
});
const integrationPathSchema = organizationPathSchema.extend({
  integrationId: z.uuid(),
});
const domainPathSchema = organizationPathSchema.extend({ domainId: z.uuid() });

const customFieldValidationSchema = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    minLength: z.number().int().nonnegative().max(4_096).optional(),
    maxLength: z.number().int().nonnegative().max(4_096).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.min === undefined ||
      value.max === undefined ||
      value.min <= value.max,
  )
  .refine(
    (value) =>
      value.minLength === undefined ||
      value.maxLength === undefined ||
      value.minLength <= value.maxLength,
  );
const customFieldBodySchema = z
  .object({
    entityType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/),
    key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(150),
    fieldType: z.enum(customFieldTypes),
    isRequired: z.boolean().default(false),
    defaultValue: z.unknown().optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    validation: customFieldValidationSchema.default({}),
    isVisible: z.boolean().default(true),
    sortOrder: z.number().int().nonnegative().max(100_000).default(0),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  })
  .strict();
const customFieldPatchSchema = customFieldBodySchema
  .partial()
  .omit({ entityType: true, key: true })
  .refine((body) => Object.keys(body).length > 0);

const workflowCreateSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_-]*$/),
    name: z.string().trim().min(1).max(150),
  })
  .strict();
const workflowPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    status: z.enum(["DRAFT", "ARCHIVED"]).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
const workflowVersionCreateSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            key: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[a-z][a-z0-9_-]*$/),
            name: z.string().trim().min(1).max(150),
            position: z.number().int().nonnegative().max(10_000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    triggers: z
      .array(
        z
          .object({
            triggerType: z
              .string()
              .trim()
              .min(1)
              .max(80)
              .regex(/^[A-Z][A-Z0-9_]*$/),
            configuration: z.record(z.string(), z.json()).default({}),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    conditions: z
      .array(
        z
          .object({
            stepKey: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[a-z][a-z0-9_-]*$/),
            field: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[a-z][a-z0-9_.]*$/),
            operator: z.enum([
              "EQ",
              "NE",
              "LT",
              "LTE",
              "GT",
              "GTE",
              "IN",
              "CONTAINS",
            ]),
            value: z.json(),
          })
          .strict(),
      )
      .max(250)
      .default([]),
    actions: z
      .array(
        z
          .object({
            stepKey: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[a-z][a-z0-9_-]*$/),
            actionType: z.enum(["NOTIFICATION", "APPROVAL"]),
            configuration: z.record(z.string(), z.json()).default({}),
            position: z.number().int().nonnegative().max(1_000).default(0),
          })
          .strict(),
      )
      .max(250)
      .default([]),
    transitions: z
      .array(
        z
          .object({
            fromStepKey: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[a-z][a-z0-9_-]*$/),
            toStepKey: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[a-z][a-z0-9_-]*$/),
            condition: z.record(z.string(), z.json()).default({}),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();

function workflowMetadataIsInert(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return value.length <= 4_096;
  if (Array.isArray(value)) {
    return value.every((item) => workflowMetadataIsInert(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return true;
  return Object.entries(value).every(
    ([key, child]) =>
      !/^(sql|query|shell|script|javascript|code|command|exec|evaluate)$/i.test(
        key,
      ) && workflowMetadataIsInert(child, depth + 1),
  );
}

const notificationChannels = [
  "IN_APP",
  "EMAIL",
  "SMS",
  "WHATSAPP",
  "WEBHOOK",
] as const;
const notificationPreferencesSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            event: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[A-Z][A-Z0-9_.-]*$/),
            channel: z.enum(notificationChannels),
            enabled: z.boolean(),
            branchId: z.uuid().optional(),
            recipientMode: z.enum([
              "ORGANIZATION_ADMINS",
              "BRANCH_MANAGERS",
              "EVENT_ACTOR",
            ]),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

const integrationProviders = [
  "PAYMENT_GATEWAY",
  "EMAIL_PROVIDER",
  "SMS_PROVIDER",
  "WHATSAPP",
  "ACCOUNTING",
  "WEBHOOK",
  "STORAGE",
] as const;
const integrationConfigurationSchema = z
  .object({
    environment: z.enum(["TEST", "LIVE"]).optional(),
    accountReference: z.string().trim().min(1).max(160).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    senderName: z.string().trim().min(1).max(100).optional(),
    endpointUrl: z
      .url()
      .startsWith("https://")
      .refine((value) => {
        const parsed = new URL(value);
        return (
          parsed.username.length === 0 &&
          parsed.password.length === 0 &&
          parsed.search.length === 0 &&
          parsed.hash.length === 0
        );
      })
      .optional(),
    testMode: z.boolean().optional(),
  })
  .strict();
const integrationCreateSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_-]*$/),
    provider: z.enum(integrationProviders),
    configuration: integrationConfigurationSchema.default({}),
  })
  .strict();
const integrationPatchSchema = z
  .object({
    provider: z.enum(integrationProviders).optional(),
    configuration: integrationConfigurationSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);

function normalizeDomain(domain: string): string | null {
  const trimmed = domain.trim().toLowerCase().replace(/\.$/, "");
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  )
    ? ascii
    : null;
}
const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform(normalizeDomain)
  .refine((value) => value !== null);
const domainCreateSchema = z
  .object({
    domain: domainSchema,
    domainType: z.enum(["DOMAIN", "SUBDOMAIN"]),
  })
  .strict();
const domainPatchSchema = z
  .object({
    domain: domainSchema.optional(),
    domainType: z.enum(["DOMAIN", "SUBDOMAIN"]).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);

const configurationPermissions = {
  customFieldsRead: "core.organization.custom_fields.read",
  customFieldsManage: "core.organization.custom_fields.manage",
  workflowsRead: "core.organization.workflows.read",
  workflowsManage: "core.organization.workflows.manage",
  notificationsRead: "core.organization.notifications.read",
  notificationsManage: "core.organization.notifications.manage",
  integrationsRead: "core.organization.integrations.read",
  integrationsManage: "core.organization.integrations.manage",
  domainsRead: "core.organization.domains.read",
  domainsManage: "core.organization.domains.manage",
} as const;

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

function response(statusCode: number, body: unknown): OperationResponse {
  return { statusCode, body };
}

function validateFieldDefault(
  fieldType: (typeof customFieldTypes)[number],
  value: unknown,
  options: readonly string[],
  validation: z.infer<typeof customFieldValidationSchema>,
): unknown {
  const parsed = parseCustomFieldValue(fieldType, value);
  if (fieldType === "SELECT" && !options.includes(parsed as string)) {
    throw new TypeError("Custom field default is not an allowed option");
  }
  if (
    fieldType === "MULTI_SELECT" &&
    (parsed as string[]).some((option) => !options.includes(option))
  ) {
    throw new TypeError("Custom field default is not an allowed option");
  }
  if (fieldType === "NUMBER" && typeof parsed === "number") {
    if (
      (validation.min !== undefined && parsed < validation.min) ||
      (validation.max !== undefined && parsed > validation.max)
    ) {
      throw new TypeError("Custom field default violates numeric validation");
    }
  }
  if (fieldType === "TEXT" && typeof parsed === "string") {
    if (
      (validation.minLength !== undefined &&
        parsed.length < validation.minLength) ||
      (validation.maxLength !== undefined &&
        parsed.length > validation.maxLength)
    ) {
      throw new TypeError("Custom field default violates length validation");
    }
  }
  return parsed;
}

function safeIntegrationConfiguration(value: unknown) {
  const parsed = integrationConfigurationSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function registerConfigurationResourceRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  app.get(
    "/organizations/:organizationId/custom-fields",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const query = z
        .object({ entityType: z.string().trim().min(1).max(100).optional() })
        .strict()
        .safeParse(request.query);
      if (!path.success || !query.success)
        return sendResponse(reply, notFound());

      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.customFieldsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const filters = [
            eq(customFieldDefinitions.organizationId, context.organizationId),
          ];
          if (query.data.entityType) {
            filters.push(
              eq(customFieldDefinitions.entityType, query.data.entityType),
            );
          }
          const fields = await transaction
            .select()
            .from(customFieldDefinitions)
            .where(and(...filters))
            .orderBy(
              asc(customFieldDefinitions.entityType),
              asc(customFieldDefinitions.sortOrder),
              asc(customFieldDefinitions.key),
            );
          return response(200, { customFields: fields });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/custom-fields",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = customFieldBodySchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid custom field." },
        });
      }
      let defaultValue: unknown = null;
      try {
        if (body.data.defaultValue !== undefined) {
          defaultValue = validateFieldDefault(
            body.data.fieldType,
            body.data.defaultValue,
            body.data.options,
            body.data.validation,
          );
        }
      } catch {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "The custom field default does not match its definition.",
          },
        });
      }
      if (
        ["SELECT", "MULTI_SELECT"].includes(body.data.fieldType) &&
        body.data.options.length === 0
      ) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Select fields require at least one option.",
          },
        });
      }

      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.customFieldsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [field] = await transaction
            .insert(customFieldDefinitions)
            .values({
              organizationId: context.organizationId,
              entityType: body.data.entityType,
              key: body.data.key,
              label: body.data.label,
              fieldType: body.data.fieldType,
              isRequired: body.data.isRequired,
              defaultValue,
              options: body.data.options,
              validation: body.data.validation,
              isVisible: body.data.isVisible,
              sortOrder: body.data.sortOrder,
              status: body.data.status,
            })
            .onConflictDoNothing({
              target: [
                customFieldDefinitions.organizationId,
                customFieldDefinitions.entityType,
                customFieldDefinitions.key,
              ],
            })
            .returning();
          if (!field) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "That custom field already exists.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "CUSTOM_FIELD_CREATED",
            "custom_field_definition",
            field.id,
            { entityType: field.entityType, key: field.key },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "custom_field_definition",
            field.id,
            ["entityType", "key", "label", "fieldType"],
          );
          return response(201, { customField: field });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/custom-fields/:fieldId",
    async (request, reply) => {
      const path = fieldPathSchema.safeParse(request.params);
      const body = customFieldPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid custom field update.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.customFieldsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [existing] = await transaction
            .select()
            .from(customFieldDefinitions)
            .where(
              and(
                eq(
                  customFieldDefinitions.organizationId,
                  context.organizationId,
                ),
                eq(customFieldDefinitions.id, path.data.fieldId),
              ),
            )
            .for("update")
            .limit(1);
          if (!existing) return notFound();
          const fieldType = body.data.fieldType ?? existing.fieldType;
          const options =
            body.data.options ?? z.array(z.string()).parse(existing.options);
          const validation =
            body.data.validation ??
            customFieldValidationSchema.parse(existing.validation);
          const update = Object.fromEntries(
            Object.entries(body.data).filter(
              ([, value]) => value !== undefined,
            ),
          ) as Partial<typeof customFieldDefinitions.$inferInsert>;
          update.updatedAt = new Date();
          if (Object.hasOwn(body.data, "defaultValue")) {
            try {
              update.defaultValue =
                body.data.defaultValue === null
                  ? null
                  : validateFieldDefault(
                      fieldType,
                      body.data.defaultValue,
                      options,
                      validation,
                    );
            } catch {
              return response(400, {
                error: {
                  code: "BAD_REQUEST",
                  message:
                    "The custom field default does not match its definition.",
                },
              });
            }
          } else if (
            body.data.fieldType !== undefined ||
            body.data.options !== undefined ||
            body.data.validation !== undefined
          ) {
            if (existing.defaultValue !== null) {
              try {
                validateFieldDefault(
                  fieldType,
                  existing.defaultValue,
                  options,
                  validation,
                );
              } catch {
                return response(409, {
                  error: {
                    code: "CONFLICT",
                    message:
                      "The current default is invalid under the updated definition.",
                  },
                });
              }
            }
          }
          if (
            ["SELECT", "MULTI_SELECT"].includes(fieldType) &&
            options.length === 0
          ) {
            return response(400, {
              error: {
                code: "BAD_REQUEST",
                message: "Select fields require at least one option.",
              },
            });
          }
          const [updated] = await transaction
            .update(customFieldDefinitions)
            .set(update)
            .where(
              and(
                eq(
                  customFieldDefinitions.organizationId,
                  context.organizationId,
                ),
                eq(customFieldDefinitions.id, path.data.fieldId),
              ),
            )
            .returning();
          if (!updated) return notFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "CUSTOM_FIELD_UPDATED",
            "custom_field_definition",
            updated.id,
            { fields: Object.keys(body.data) },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "custom_field_definition",
            updated.id,
            Object.keys(body.data),
          );
          return response(200, { customField: updated });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.delete(
    "/organizations/:organizationId/custom-fields/:fieldId",
    async (request, reply) => {
      const path = fieldPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.customFieldsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [deleted] = await transaction
            .delete(customFieldDefinitions)
            .where(
              and(
                eq(
                  customFieldDefinitions.organizationId,
                  context.organizationId,
                ),
                eq(customFieldDefinitions.id, path.data.fieldId),
              ),
            )
            .returning({
              id: customFieldDefinitions.id,
              key: customFieldDefinitions.key,
            });
          if (!deleted) return notFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "CUSTOM_FIELD_DELETED",
            "custom_field_definition",
            deleted.id,
            { key: deleted.key },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "custom_field_definition",
            deleted.id,
            ["deleted"],
          );
          return response(204, null);
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/workflows",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.workflowsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const workflows = await transaction
            .select()
            .from(workflowDefinitions)
            .where(
              eq(workflowDefinitions.organizationId, context.organizationId),
            )
            .orderBy(asc(workflowDefinitions.key));
          return response(200, { workflows });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/workflows",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = workflowCreateSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid workflow." },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.workflowsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [workflow] = await transaction
            .insert(workflowDefinitions)
            .values({
              organizationId: context.organizationId,
              key: body.data.key,
              name: body.data.name,
            })
            .onConflictDoNothing({
              target: [
                workflowDefinitions.organizationId,
                workflowDefinitions.key,
              ],
            })
            .returning();
          if (!workflow) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "That workflow already exists.",
              },
            });
          }
          await transaction.insert(workflowVersions).values({
            organizationId: context.organizationId,
            workflowId: workflow.id,
            version: 1,
            status: "DRAFT",
          });
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "WORKFLOW_CREATED",
            "workflow_definition",
            workflow.id,
            { key: workflow.key },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "workflow_definition",
            workflow.id,
            ["created", "key", "name"],
          );
          return response(201, { workflow, initialVersion: 1 });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/workflows/:workflowId",
    async (request, reply) => {
      const path = workflowPathSchema.safeParse(request.params);
      const body = workflowPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid workflow update." },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.workflowsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [existing] = await transaction
            .select()
            .from(workflowDefinitions)
            .where(
              and(
                eq(workflowDefinitions.organizationId, context.organizationId),
                eq(workflowDefinitions.id, path.data.workflowId),
              ),
            )
            .for("update")
            .limit(1);
          if (!existing) return notFound();
          if (existing.status === "ACTIVE") {
            return response(409, {
              error: {
                code: "CONFLICT",
                message:
                  "Use workflow version activation controls to change active state.",
              },
            });
          }
          const [updated] = await transaction
            .update(workflowDefinitions)
            .set({ ...body.data, updatedAt: new Date() })
            .where(eq(workflowDefinitions.id, existing.id))
            .returning();
          if (!updated) return notFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "WORKFLOW_UPDATED",
            "workflow_definition",
            updated.id,
            { fields: Object.keys(body.data) },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "workflow_definition",
            updated.id,
            Object.keys(body.data),
          );
          return response(200, { workflow: updated });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/workflows/:workflowId/versions",
    async (request, reply) => {
      const path = workflowPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.workflowsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const versions = await transaction
            .select()
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.organizationId, context.organizationId),
                eq(workflowVersions.workflowId, path.data.workflowId),
              ),
            )
            .orderBy(desc(workflowVersions.version));
          if (versions.length === 0) {
            const [workflow] = await transaction
              .select({ id: workflowDefinitions.id })
              .from(workflowDefinitions)
              .where(
                and(
                  eq(
                    workflowDefinitions.organizationId,
                    context.organizationId,
                  ),
                  eq(workflowDefinitions.id, path.data.workflowId),
                ),
              )
              .limit(1);
            if (!workflow) return notFound();
          }
          const versionIds = versions.map(({ id }) => id);
          const steps = versionIds.length
            ? await transaction
                .select()
                .from(workflowSteps)
                .where(
                  and(
                    eq(workflowSteps.organizationId, context.organizationId),
                    inArray(workflowSteps.workflowVersionId, versionIds),
                  ),
                )
            : [];
          const stepIds = steps.map(({ id }) => id);
          const triggers = versionIds.length
            ? await transaction
                .select()
                .from(workflowTriggers)
                .where(
                  and(
                    eq(workflowTriggers.organizationId, context.organizationId),
                    inArray(workflowTriggers.workflowVersionId, versionIds),
                  ),
                )
            : [];
          const transitions = versionIds.length
            ? await transaction
                .select()
                .from(workflowTransitions)
                .where(
                  and(
                    eq(
                      workflowTransitions.organizationId,
                      context.organizationId,
                    ),
                    inArray(workflowTransitions.workflowVersionId, versionIds),
                  ),
                )
            : [];
          const conditions = stepIds.length
            ? await transaction
                .select()
                .from(workflowConditions)
                .where(
                  and(
                    eq(
                      workflowConditions.organizationId,
                      context.organizationId,
                    ),
                    inArray(workflowConditions.workflowStepId, stepIds),
                  ),
                )
            : [];
          const actions = stepIds.length
            ? await transaction
                .select()
                .from(workflowActions)
                .where(
                  and(
                    eq(workflowActions.organizationId, context.organizationId),
                    inArray(workflowActions.workflowStepId, stepIds),
                  ),
                )
            : [];
          return response(200, {
            versions: versions.map((version) => {
              const versionSteps = steps.filter(
                (step) => step.workflowVersionId === version.id,
              );
              const versionStepIds = new Set(versionSteps.map(({ id }) => id));
              return {
                ...version,
                steps: versionSteps,
                triggers: triggers.filter(
                  (trigger) => trigger.workflowVersionId === version.id,
                ),
                transitions: transitions.filter(
                  (transition) => transition.workflowVersionId === version.id,
                ),
                conditions: conditions.filter((condition) =>
                  versionStepIds.has(condition.workflowStepId),
                ),
                actions: actions.filter((action) =>
                  versionStepIds.has(action.workflowStepId),
                ),
              };
            }),
          });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/workflows/:workflowId/versions",
    async (request, reply) => {
      const path = workflowPathSchema.safeParse(request.params);
      const body = workflowVersionCreateSchema.safeParse(request.body ?? {});
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid workflow version." },
        });
      }
      const stepKeys = body.data.steps.map(({ key }) => key);
      const stepKeySet = new Set(stepKeys);
      const referencedStepKeys = [
        ...body.data.conditions.map(({ stepKey }) => stepKey),
        ...body.data.actions.map(({ stepKey }) => stepKey),
        ...body.data.transitions.flatMap(({ fromStepKey, toStepKey }) => [
          fromStepKey,
          toStepKey,
        ]),
      ];
      const workflowMetadata = {
        triggers: body.data.triggers,
        conditions: body.data.conditions,
        actions: body.data.actions,
        transitions: body.data.transitions,
      };
      if (
        stepKeySet.size !== stepKeys.length ||
        referencedStepKeys.some((stepKey) => !stepKeySet.has(stepKey)) ||
        JSON.stringify(workflowMetadata).length > 65_536 ||
        !workflowMetadataIsInert(workflowMetadata)
      ) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message:
              "Workflow metadata is invalid or contains executable fields.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.workflowsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [workflow] = await transaction
            .select({ id: workflowDefinitions.id })
            .from(workflowDefinitions)
            .where(
              and(
                eq(workflowDefinitions.organizationId, context.organizationId),
                eq(workflowDefinitions.id, path.data.workflowId),
              ),
            )
            .for("update")
            .limit(1);
          if (!workflow) return notFound();
          const priorVersions = await transaction
            .select({ version: workflowVersions.version })
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.organizationId, context.organizationId),
                eq(workflowVersions.workflowId, workflow.id),
              ),
            )
            .orderBy(desc(workflowVersions.version))
            .limit(1);
          const nextVersion = (priorVersions[0]?.version ?? 0) + 1;
          const [version] = await transaction
            .insert(workflowVersions)
            .values({
              organizationId: context.organizationId,
              workflowId: workflow.id,
              version: nextVersion,
              status: "DRAFT",
            })
            .returning();
          if (!version) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "Workflow version was not created.",
              },
            });
          }
          const insertedSteps = body.data.steps.length
            ? await transaction
                .insert(workflowSteps)
                .values(
                  body.data.steps.map((step) => ({
                    organizationId: context.organizationId,
                    workflowVersionId: version.id,
                    ...step,
                  })),
                )
                .returning({ id: workflowSteps.id, key: workflowSteps.key })
            : [];
          const stepIdByKey = new Map(
            insertedSteps.map((step) => [step.key, step.id]),
          );
          if (body.data.triggers.length) {
            await transaction.insert(workflowTriggers).values(
              body.data.triggers.map((trigger) => ({
                organizationId: context.organizationId,
                workflowVersionId: version.id,
                triggerType: trigger.triggerType,
                configuration: trigger.configuration,
              })),
            );
          }
          if (body.data.conditions.length) {
            await transaction.insert(workflowConditions).values(
              body.data.conditions.map((condition) => ({
                organizationId: context.organizationId,
                workflowStepId: stepIdByKey.get(condition.stepKey)!,
                expression: {
                  field: condition.field,
                  operator: condition.operator,
                  value: condition.value,
                },
              })),
            );
          }
          if (body.data.actions.length) {
            await transaction.insert(workflowActions).values(
              body.data.actions.map((action) => ({
                organizationId: context.organizationId,
                workflowStepId: stepIdByKey.get(action.stepKey)!,
                actionType: action.actionType,
                configuration: action.configuration,
                position: action.position,
              })),
            );
          }
          if (body.data.transitions.length) {
            await transaction.insert(workflowTransitions).values(
              body.data.transitions.map((transition) => ({
                organizationId: context.organizationId,
                workflowVersionId: version.id,
                fromStepId: stepIdByKey.get(transition.fromStepKey)!,
                toStepId: stepIdByKey.get(transition.toStepKey)!,
                condition: transition.condition,
              })),
            );
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "WORKFLOW_UPDATED",
            "workflow_version",
            version.id,
            { workflowId: workflow.id, version: nextVersion },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "workflow_version",
            version.id,
            [
              "version",
              "steps",
              "triggers",
              "conditions",
              "actions",
              "transitions",
            ],
          );
          return response(201, { version });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/workflows/:workflowId/versions/:versionId/activate",
    async (request, reply) => {
      const path = workflowVersionPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.workflowsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [workflow] = await transaction
            .select()
            .from(workflowDefinitions)
            .where(
              and(
                eq(workflowDefinitions.organizationId, context.organizationId),
                eq(workflowDefinitions.id, path.data.workflowId),
              ),
            )
            .for("update")
            .limit(1);
          const [version] = await transaction
            .select()
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.organizationId, context.organizationId),
                eq(workflowVersions.workflowId, path.data.workflowId),
                eq(workflowVersions.id, path.data.versionId),
              ),
            )
            .for("update")
            .limit(1);
          if (!workflow || !version) return notFound();
          if (version.status !== "DRAFT") {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "Only a draft workflow version can be activated.",
              },
            });
          }
          await transaction
            .update(workflowVersions)
            .set({ status: "RETIRED" })
            .where(
              and(
                eq(workflowVersions.organizationId, context.organizationId),
                eq(workflowVersions.workflowId, workflow.id),
                eq(workflowVersions.status, "PUBLISHED"),
              ),
            );
          const [activated] = await transaction
            .update(workflowVersions)
            .set({ status: "PUBLISHED", publishedAt: new Date() })
            .where(eq(workflowVersions.id, version.id))
            .returning();
          await transaction
            .update(workflowDefinitions)
            .set({ status: "ACTIVE", updatedAt: new Date() })
            .where(eq(workflowDefinitions.id, workflow.id));
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "WORKFLOW_ACTIVATED",
            "workflow_version",
            version.id,
            { workflowId: workflow.id, version: version.version },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "workflow_version",
            version.id,
            ["activated"],
          );
          return response(200, { version: activated });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/workflows/:workflowId/versions/:versionId/deactivate",
    async (request, reply) => {
      const path = workflowVersionPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.workflowsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [version] = await transaction
            .update(workflowVersions)
            .set({ status: "RETIRED" })
            .where(
              and(
                eq(workflowVersions.organizationId, context.organizationId),
                eq(workflowVersions.workflowId, path.data.workflowId),
                eq(workflowVersions.id, path.data.versionId),
                eq(workflowVersions.status, "PUBLISHED"),
              ),
            )
            .returning();
          if (!version) return notFound();
          await transaction
            .update(workflowDefinitions)
            .set({ status: "DRAFT", updatedAt: new Date() })
            .where(
              and(
                eq(workflowDefinitions.organizationId, context.organizationId),
                eq(workflowDefinitions.id, path.data.workflowId),
              ),
            );
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "WORKFLOW_DEACTIVATED",
            "workflow_version",
            version.id,
            { workflowId: path.data.workflowId, version: version.version },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "workflow_version",
            version.id,
            ["deactivated"],
          );
          return response(200, { version });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/notification-settings",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.notificationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [configuration] = await transaction
            .select({ preferences: notificationConfigurations.preferences })
            .from(notificationConfigurations)
            .where(
              eq(
                notificationConfigurations.organizationId,
                context.organizationId,
              ),
            )
            .limit(1);
          const parsed = notificationPreferencesSchema.safeParse(
            configuration?.preferences,
          );
          const preferences = parsed.success
            ? {
                events: parsed.data.events.filter(
                  (event) =>
                    event.branchId === undefined ||
                    event.branchId === context.branch?.branchId,
                ),
              }
            : { events: [] };
          return response(200, { preferences });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/notification-settings",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = notificationPreferencesSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid notification settings.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.notificationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          if (
            body.data.events.some(
              (event) =>
                event.branchId !== undefined &&
                event.branchId !== context.branch?.branchId,
            )
          ) {
            return response(403, {
              error: {
                code: "FORBIDDEN",
                message:
                  "A notification branch must match the verified branch context.",
              },
            });
          }
          const [existing] = await transaction
            .select({
              organizationId: notificationConfigurations.organizationId,
            })
            .from(notificationConfigurations)
            .where(
              eq(
                notificationConfigurations.organizationId,
                context.organizationId,
              ),
            )
            .limit(1);
          if (existing) {
            await transaction
              .update(notificationConfigurations)
              .set({ preferences: body.data, updatedAt: new Date() })
              .where(
                eq(
                  notificationConfigurations.organizationId,
                  context.organizationId,
                ),
              );
          } else {
            await transaction.insert(notificationConfigurations).values({
              organizationId: context.organizationId,
              preferences: body.data,
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "NOTIFICATION_CONFIGURATION_UPDATED",
            "notification_configuration",
            context.organizationId,
            { eventCount: body.data.events.length },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "notification_configuration",
            context.organizationId,
            ["preferences"],
          );
          return response(200, { preferences: body.data });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/integrations",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.integrationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const records = await transaction
            .select({
              id: integrations.id,
              key: integrations.key,
              provider: integrations.provider,
              status: integrations.status,
              configuration: integrations.configuration,
              createdAt: integrations.createdAt,
              updatedAt: integrations.updatedAt,
            })
            .from(integrations)
            .where(eq(integrations.organizationId, context.organizationId))
            .orderBy(asc(integrations.key));
          return response(200, {
            integrations: records.map((integration) => ({
              ...integration,
              configuration: safeIntegrationConfiguration(
                integration.configuration,
              ),
            })),
          });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/integrations",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = integrationCreateSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid integration metadata. Secrets are not accepted.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [created] = await transaction
            .insert(integrations)
            .values({
              organizationId: context.organizationId,
              key: body.data.key,
              provider: body.data.provider,
              configuration: safeIntegrationConfiguration(
                body.data.configuration,
              ),
              status: "PENDING",
              secretReference: null,
            })
            .onConflictDoNothing({
              target: [integrations.organizationId, integrations.key],
            })
            .returning({
              id: integrations.id,
              key: integrations.key,
              provider: integrations.provider,
              status: integrations.status,
              configuration: integrations.configuration,
              createdAt: integrations.createdAt,
              updatedAt: integrations.updatedAt,
            });
          if (!created) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "That integration already exists.",
              },
            });
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "INTEGRATION_CONFIGURATION_CREATED",
            "integration",
            created.id,
            { key: created.key, provider: created.provider },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "integration",
            created.id,
            ["created", "provider", "configuration"],
          );
          return response(201, {
            integration: {
              ...created,
              configuration: safeIntegrationConfiguration(
                created.configuration,
              ),
            },
          });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.patch(
    "/organizations/:organizationId/integrations/:integrationId",
    async (request, reply) => {
      const path = integrationPathSchema.safeParse(request.params);
      const body = integrationPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid integration metadata. Secrets are not accepted.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [updated] = await transaction
            .update(integrations)
            .set({
              ...body.data,
              configuration:
                body.data.configuration === undefined
                  ? undefined
                  : safeIntegrationConfiguration(body.data.configuration),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(integrations.organizationId, context.organizationId),
                eq(integrations.id, path.data.integrationId),
              ),
            )
            .returning({
              id: integrations.id,
              key: integrations.key,
              provider: integrations.provider,
              status: integrations.status,
              configuration: integrations.configuration,
              createdAt: integrations.createdAt,
              updatedAt: integrations.updatedAt,
            });
          if (!updated) return notFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "INTEGRATION_CONFIGURATION_UPDATED",
            "integration",
            updated.id,
            { fields: Object.keys(body.data) },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "integration",
            updated.id,
            Object.keys(body.data),
          );
          return response(200, {
            integration: {
              ...updated,
              configuration: safeIntegrationConfiguration(
                updated.configuration,
              ),
            },
          });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.delete(
    "/organizations/:organizationId/integrations/:integrationId",
    async (request, reply) => {
      const path = integrationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [deleted] = await transaction
            .delete(integrations)
            .where(
              and(
                eq(integrations.organizationId, context.organizationId),
                eq(integrations.id, path.data.integrationId),
              ),
            )
            .returning({ id: integrations.id, key: integrations.key });
          if (!deleted) return notFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "INTEGRATION_CONFIGURATION_DELETED",
            "integration",
            deleted.id,
            { key: deleted.key },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "integration",
            deleted.id,
            ["deleted"],
          );
          return response(204, null);
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get("/organizations/:organizationId/domains", async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    if (!path.success) return sendResponse(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      configurationPermissions.domainsRead,
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context)) {
          return notFound();
        }
        const domains = await transaction
          .select({
            id: customDomains.id,
            domain: customDomains.domain,
            domainType: customDomains.domainType,
            isPrimary: customDomains.isPrimary,
            verificationStatus: customDomains.verificationStatus,
            sslStatus: customDomains.sslStatus,
            verifiedAt: customDomains.verifiedAt,
            createdAt: customDomains.createdAt,
            updatedAt: customDomains.updatedAt,
          })
          .from(customDomains)
          .where(eq(customDomains.organizationId, context.organizationId))
          .orderBy(asc(customDomains.domain));
        return response(200, { domains });
      },
    );
    if (!result.allowed) return denied(reply, result.statusCode);
    return sendResponse(reply, result.value);
  });

  app.post("/organizations/:organizationId/domains", async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const body = domainCreateSchema.safeParse(request.body);
    if (!path.success || !body.success || body.data.domain === null) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "Invalid custom domain." },
      });
    }
    const result = await authorization.withPermission(
      requestContext(request),
      configurationPermissions.domainsManage,
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context)) {
          return notFound();
        }
        const [created] = await transaction
          .insert(customDomains)
          .values({
            organizationId: context.organizationId,
            domain: body.data.domain,
            domainType: body.data.domainType,
            isPrimary: false,
            verificationStatus: "PENDING",
            sslStatus: "PENDING",
          })
          .onConflictDoNothing({ target: customDomains.domain })
          .returning({
            id: customDomains.id,
            domain: customDomains.domain,
            domainType: customDomains.domainType,
            isPrimary: customDomains.isPrimary,
            verificationStatus: customDomains.verificationStatus,
            sslStatus: customDomains.sslStatus,
            createdAt: customDomains.createdAt,
            updatedAt: customDomains.updatedAt,
          });
        if (!created) {
          return response(409, {
            error: {
              code: "CONFLICT",
              message: "That domain is already registered.",
            },
          });
        }
        await writeAuthorizationMutationEvent(
          transaction,
          context,
          { requestId: request.id },
          "CUSTOM_DOMAIN_CREATED",
          "custom_domain",
          created.id,
          { domain: created.domain },
        );
        await recordConfigurationChangedEvent(
          transaction,
          context,
          request.id,
          "custom_domain",
          created.id,
          ["created", "domainType"],
        );
        return response(201, { domain: created });
      },
    );
    if (!result.allowed) return denied(reply, result.statusCode);
    return sendResponse(reply, result.value);
  });

  app.patch(
    "/organizations/:organizationId/domains/:domainId",
    async (request, reply) => {
      const path = domainPathSchema.safeParse(request.params);
      const body = domainPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid custom domain update.",
          },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.domainsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [existing] = await transaction
            .select()
            .from(customDomains)
            .where(
              and(
                eq(customDomains.organizationId, context.organizationId),
                eq(customDomains.id, path.data.domainId),
              ),
            )
            .for("update")
            .limit(1);
          if (!existing) return notFound();
          if (
            body.data.isPrimary &&
            existing.verificationStatus !== "VERIFIED"
          ) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "Only a verified domain can be primary.",
              },
            });
          }
          if (body.data.isPrimary === true) {
            await transaction
              .update(customDomains)
              .set({ isPrimary: false, updatedAt: new Date() })
              .where(
                and(
                  eq(customDomains.organizationId, context.organizationId),
                  ne(customDomains.id, existing.id),
                  eq(customDomains.isPrimary, true),
                ),
              );
          }
          const domainChanged =
            body.data.domain !== undefined &&
            body.data.domain !== existing.domain;
          const [updated] = await transaction
            .update(customDomains)
            .set({
              ...body.data,
              domain: body.data.domain ?? existing.domain,
              isPrimary: domainChanged
                ? false
                : (body.data.isPrimary ?? existing.isPrimary),
              verificationStatus: domainChanged
                ? "PENDING"
                : existing.verificationStatus,
              sslStatus: domainChanged ? "PENDING" : existing.sslStatus,
              verifiedAt: domainChanged ? null : existing.verifiedAt,
              updatedAt: new Date(),
            })
            .where(eq(customDomains.id, existing.id))
            .returning({
              id: customDomains.id,
              domain: customDomains.domain,
              domainType: customDomains.domainType,
              isPrimary: customDomains.isPrimary,
              verificationStatus: customDomains.verificationStatus,
              sslStatus: customDomains.sslStatus,
              verifiedAt: customDomains.verifiedAt,
              updatedAt: customDomains.updatedAt,
            });
          if (!updated) return notFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "CUSTOM_DOMAIN_UPDATED",
            "custom_domain",
            updated.id,
            { fields: Object.keys(body.data), domainChanged },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "custom_domain",
            updated.id,
            Object.keys(body.data),
          );
          return response(200, { domain: updated });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.delete(
    "/organizations/:organizationId/domains/:domainId",
    async (request, reply) => {
      const path = domainPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        configurationPermissions.domainsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context)) {
            return notFound();
          }
          const [deleted] = await transaction
            .delete(customDomains)
            .where(
              and(
                eq(customDomains.organizationId, context.organizationId),
                eq(customDomains.id, path.data.domainId),
              ),
            )
            .returning({ id: customDomains.id, domain: customDomains.domain });
          if (!deleted) return notFound();
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "CUSTOM_DOMAIN_REMOVED",
            "custom_domain",
            deleted.id,
            { domain: deleted.domain },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "custom_domain",
            deleted.id,
            ["deleted"],
          );
          return response(204, null);
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );
}
