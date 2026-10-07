import {
  eventTypeSchema,
  type SecretPurpose,
  type SecretReference,
  type SecretStore,
} from "@onecore/core-domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  integrations,
  webhookDeliveryAttempts,
  webhookDeliveries,
  webhookSubscriptions,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationService,
  type OrganizationTransaction,
} from "@onecore/database";
import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import { recordConfigurationChangedEvent } from "./event-publication.js";
import { validateWebhookEndpoint } from "./webhook-endpoint.js";
import { IntegrationBackendUnavailableError } from "./integration-boundaries.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const integrationPathSchema = organizationPathSchema.extend({
  integrationId: z.uuid(),
});
const webhookPathSchema = organizationPathSchema.extend({
  webhookId: z.uuid(),
});
const credentialInputSchema = z
  .object({ secret: z.string().min(1).max(16_384) })
  .strict();
const eventTypesSchema = z
  .array(eventTypeSchema)
  .min(1)
  .max(100)
  .refine((eventTypes) => new Set(eventTypes).size === eventTypes.length);
const endpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((endpoint) => {
    try {
      validateWebhookEndpoint(endpoint);
      return true;
    } catch {
      return false;
    }
  });
const webhookCreateSchema = z
  .object({
    integrationId: z.uuid(),
    endpointUrl: endpointSchema,
    eventTypes: eventTypesSchema,
    signingSecret: z.string().min(32).max(4_096),
    description: z.string().trim().max(256).optional(),
  })
  .strict();
const webhookPatchSchema = z
  .object({
    endpointUrl: endpointSchema.optional(),
    eventTypes: eventTypesSchema.optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    description: z.string().trim().max(256).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
const signingSecretSchema = z
  .object({ signingSecret: z.string().min(32).max(4_096) })
  .strict();
const deliveryQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
const deliveryAttemptPathSchema = webhookPathSchema.extend({
  deliveryId: z.uuid(),
});

const integrationsRead = "core.organization.integrations.read";
const integrationsManage = "core.organization.integrations.manage";

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
  if (!request.auth) return null;
  return {
    userId: request.auth.userId,
    sessionId: request.auth.sessionId,
    organizationId: request.auth.organizationId,
    membershipId: request.auth.membershipId,
    branchId: request.auth.branchId,
  };
}

function response(statusCode: number, body: unknown): OperationResponse {
  return { statusCode, body };
}

function notFound(): OperationResponse {
  return response(404, {
    error: {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    },
  });
}

function backendUnavailable(): OperationResponse {
  return response(503, {
    error: {
      code: "INTEGRATION_BACKEND_UNAVAILABLE",
      message: "The integration security backend is unavailable.",
    },
  });
}

function denied(reply: FastifyReply, statusCode: 401 | 403) {
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

function secretReference(value: string): SecretReference {
  return value as SecretReference;
}

function publicWebhook<T extends { signingSecretReference: string | null }>(
  record: T,
) {
  const { signingSecretReference, ...metadata } = record;
  return { ...metadata, hasSigningSecret: signingSecretReference !== null };
}

async function cancelSubscriptionDeliveries(
  transaction: OrganizationTransaction,
  organizationId: string,
  subscriptionId: string,
  now: Date,
): Promise<number> {
  const deliveries = await transaction
    .select({ id: webhookDeliveries.id, status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.subscriptionId, subscriptionId),
        inArray(webhookDeliveries.status, [
          "PENDING",
          "RETRYING",
          "PROCESSING",
        ]),
      ),
    )
    .for("update");
  if (deliveries.length === 0) return 0;

  const deliveryIds = deliveries.map(({ id }) => id);
  await transaction
    .update(webhookDeliveries)
    .set({
      status: "CANCELLED",
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        inArray(webhookDeliveries.id, deliveryIds),
      ),
    );
  await transaction
    .update(webhookDeliveryAttempts)
    .set({ status: "CANCELLED", completedAt: now })
    .where(
      and(
        eq(webhookDeliveryAttempts.organizationId, organizationId),
        inArray(webhookDeliveryAttempts.deliveryId, deliveryIds),
        eq(webhookDeliveryAttempts.status, "IN_PROGRESS"),
      ),
    );
  return deliveryIds.length;
}

async function storeSecret(
  secretStore: SecretStore,
  organizationId: string,
  purpose: SecretPurpose,
  secret: string,
): Promise<SecretReference> {
  try {
    return await secretStore.store({
      organizationId,
      purpose,
      value: new TextEncoder().encode(secret),
    });
  } catch {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  }
}

async function rotateSecret(
  secretStore: SecretStore,
  organizationId: string,
  purpose: SecretPurpose,
  reference: string,
  secret: string,
): Promise<SecretReference> {
  try {
    return await secretStore.rotate({
      organizationId,
      purpose,
      reference: secretReference(reference),
      value: new TextEncoder().encode(secret),
    });
  } catch {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  }
}

async function deleteSecret(
  secretStore: SecretStore,
  organizationId: string,
  purpose: SecretPurpose,
  reference: string,
): Promise<void> {
  try {
    await secretStore.delete({
      organizationId,
      purpose,
      reference: secretReference(reference),
    });
  } catch {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  }
}

async function bestEffortDeleteSecret(
  secretStore: SecretStore,
  organizationId: string,
  purpose: SecretPurpose,
  reference: SecretReference,
): Promise<void> {
  try {
    await secretStore.delete({ organizationId, purpose, reference });
  } catch {
    // The reference is not exposed; orphan cleanup is retried operationally.
  }
}

export function registerIntegrationSecurityRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService,
  secretStore: SecretStore,
): void {
  app.get(
    "/organizations/:organizationId/integrations/:integrationId/credentials",
    async (request, reply) => {
      const path = integrationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        integrationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const [integration] = await transaction
            .select({
              id: integrations.id,
              secretReference: integrations.secretReference,
            })
            .from(integrations)
            .where(
              and(
                eq(integrations.organizationId, context.organizationId),
                eq(integrations.id, path.data.integrationId),
              ),
            )
            .limit(1);
          if (!integration) return notFound();
          if (!integration.secretReference) {
            return response(200, { credential: { configured: false } });
          }
          try {
            const metadata = await secretStore.metadata({
              organizationId: context.organizationId,
              purpose: "INTEGRATION_CREDENTIAL",
              reference: secretReference(integration.secretReference),
            });
            if (!metadata) return backendUnavailable();
            return response(200, {
              credential: {
                configured: true,
                createdAt: metadata.createdAt,
                updatedAt: metadata.updatedAt,
                version: metadata.version,
              },
            });
          } catch {
            return backendUnavailable();
          }
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  const configureCredential =
    (rotate: boolean) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const path = integrationPathSchema.safeParse(request.params);
      const body = credentialInputSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "A valid credential value is required.",
          },
        });
      }

      let createdReference: SecretReference | undefined;
      let previousReference: string | null = null;
      try {
        const result = await authorization.withPermission(
          requestContext(request),
          integrationsManage,
          { requestId: request.id },
          async (transaction, context) => {
            if (context.organizationId !== path.data.organizationId) {
              return notFound();
            }
            const [integration] = await transaction
              .select({
                id: integrations.id,
                secretReference: integrations.secretReference,
              })
              .from(integrations)
              .where(
                and(
                  eq(integrations.organizationId, context.organizationId),
                  eq(integrations.id, path.data.integrationId),
                ),
              )
              .for("update")
              .limit(1);
            if (!integration) return notFound();
            if (!rotate && integration.secretReference) {
              return response(409, {
                error: {
                  code: "CONFLICT",
                  message: "A credential is already configured.",
                },
              });
            }
            if (rotate && !integration.secretReference) {
              return response(409, {
                error: {
                  code: "CONFLICT",
                  message: "No credential is configured to rotate.",
                },
              });
            }
            try {
              createdReference = rotate
                ? await rotateSecret(
                    secretStore,
                    context.organizationId,
                    "INTEGRATION_CREDENTIAL",
                    integration.secretReference!,
                    body.data.secret,
                  )
                : await storeSecret(
                    secretStore,
                    context.organizationId,
                    "INTEGRATION_CREDENTIAL",
                    body.data.secret,
                  );
            } catch {
              return backendUnavailable();
            }
            previousReference = integration.secretReference;
            await transaction
              .update(integrations)
              .set({ secretReference: createdReference, updatedAt: new Date() })
              .where(
                and(
                  eq(integrations.organizationId, context.organizationId),
                  eq(integrations.id, integration.id),
                ),
              );
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              rotate
                ? "INTEGRATION_CREDENTIAL_ROTATED"
                : "INTEGRATION_CREDENTIAL_CREATED",
              "integration",
              integration.id,
              { credentialConfigured: true },
            );
            await recordConfigurationChangedEvent(
              transaction,
              context,
              request.id,
              "integration",
              integration.id,
              [rotate ? "credentialRotated" : "credentialConfigured"],
            );
            return response(rotate ? 200 : 201, {
              credential: { configured: true },
            });
          },
        );
        if (!result.allowed) return denied(reply, result.statusCode);
        if (result.value.statusCode >= 400) {
          if (createdReference) {
            await bestEffortDeleteSecret(
              secretStore,
              path.data.organizationId,
              "INTEGRATION_CREDENTIAL",
              createdReference,
            );
          }
          return sendResponse(reply, result.value);
        }
        if (previousReference && previousReference !== createdReference) {
          await bestEffortDeleteSecret(
            secretStore,
            path.data.organizationId,
            "INTEGRATION_CREDENTIAL",
            secretReference(previousReference),
          );
        }
        return sendResponse(reply, result.value);
      } catch (error) {
        if (createdReference) {
          await bestEffortDeleteSecret(
            secretStore,
            path.data.organizationId,
            "INTEGRATION_CREDENTIAL",
            createdReference,
          );
        }
        if (error instanceof IntegrationBackendUnavailableError) {
          return sendResponse(reply, backendUnavailable());
        }
        throw error;
      }
    };

  app.post(
    "/organizations/:organizationId/integrations/:integrationId/credentials",
    configureCredential(false),
  );
  app.post(
    "/organizations/:organizationId/integrations/:integrationId/credentials/rotate",
    configureCredential(true),
  );
  app.delete(
    "/organizations/:organizationId/integrations/:integrationId/credentials",
    async (request, reply) => {
      const path = integrationPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const [integration] = await transaction
            .select({
              id: integrations.id,
              secretReference: integrations.secretReference,
            })
            .from(integrations)
            .where(
              and(
                eq(integrations.organizationId, context.organizationId),
                eq(integrations.id, path.data.integrationId),
              ),
            )
            .for("update")
            .limit(1);
          if (!integration) return notFound();
          if (!integration.secretReference) return response(204, null);
          try {
            await deleteSecret(
              secretStore,
              context.organizationId,
              "INTEGRATION_CREDENTIAL",
              integration.secretReference,
            );
          } catch {
            return backendUnavailable();
          }
          await transaction
            .update(integrations)
            .set({ secretReference: null, updatedAt: new Date() })
            .where(
              and(
                eq(integrations.organizationId, context.organizationId),
                eq(integrations.id, integration.id),
              ),
            );
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "INTEGRATION_CREDENTIAL_REVOKED",
            "integration",
            integration.id,
            { credentialConfigured: false },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "integration",
            integration.id,
            ["credentialRevoked"],
          );
          return response(204, null);
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get("/organizations/:organizationId/webhooks", async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    if (!path.success) return sendResponse(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      integrationsRead,
      { requestId: request.id },
      async (transaction, context) => {
        if (context.organizationId !== path.data.organizationId) {
          return notFound();
        }
        const subscriptions = await transaction
          .select()
          .from(webhookSubscriptions)
          .where(
            eq(webhookSubscriptions.organizationId, context.organizationId),
          )
          .orderBy(asc(webhookSubscriptions.createdAt));
        return response(200, {
          webhooks: subscriptions.map(publicWebhook),
        });
      },
    );
    if (!result.allowed) return denied(reply, result.statusCode);
    return sendResponse(reply, result.value);
  });

  app.post(
    "/organizations/:organizationId/webhooks",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = webhookCreateSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid webhook subscription metadata or signing secret.",
          },
        });
      }
      if (new TextEncoder().encode(body.data.signingSecret).byteLength < 32) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Signing secret is too short.",
          },
        });
      }
      let createdReference: SecretReference | undefined;
      try {
        const result = await authorization.withPermission(
          requestContext(request),
          integrationsManage,
          { requestId: request.id },
          async (transaction, context) => {
            if (context.organizationId !== path.data.organizationId) {
              return notFound();
            }
            const [integration] = await transaction
              .select({ id: integrations.id, provider: integrations.provider })
              .from(integrations)
              .where(
                and(
                  eq(integrations.organizationId, context.organizationId),
                  eq(integrations.id, body.data.integrationId),
                ),
              )
              .limit(1);
            if (!integration || integration.provider !== "WEBHOOK") {
              return notFound();
            }
            try {
              createdReference = await storeSecret(
                secretStore,
                context.organizationId,
                "WEBHOOK_SIGNING",
                body.data.signingSecret,
              );
            } catch {
              return backendUnavailable();
            }
            const [created] = await transaction
              .insert(webhookSubscriptions)
              .values({
                organizationId: context.organizationId,
                integrationId: integration.id,
                endpointUrl: validateWebhookEndpoint(body.data.endpointUrl)
                  .href,
                eventTypes: body.data.eventTypes,
                status: "ACTIVE",
                signingSecretReference: createdReference,
                description: body.data.description ?? null,
              })
              .returning();
            if (!created) throw new Error("WEBHOOK_SUBSCRIPTION_CREATE_FAILED");
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              "WEBHOOK_SUBSCRIPTION_CREATED",
              "webhook_subscription",
              created.id,
              { integrationId: integration.id, eventTypes: created.eventTypes },
            );
            await recordConfigurationChangedEvent(
              transaction,
              context,
              request.id,
              "webhook_subscription",
              created.id,
              ["created", "endpointUrl", "eventTypes"],
            );
            return response(201, { webhook: publicWebhook(created) });
          },
        );
        if (!result.allowed) return denied(reply, result.statusCode);
        if (result.value.statusCode >= 400 && createdReference) {
          await bestEffortDeleteSecret(
            secretStore,
            path.data.organizationId,
            "WEBHOOK_SIGNING",
            createdReference,
          );
        }
        return sendResponse(reply, result.value);
      } catch (error) {
        if (createdReference) {
          await bestEffortDeleteSecret(
            secretStore,
            path.data.organizationId,
            "WEBHOOK_SIGNING",
            createdReference,
          );
        }
        if (error instanceof IntegrationBackendUnavailableError) {
          return sendResponse(reply, backendUnavailable());
        }
        throw error;
      }
    },
  );

  app.patch(
    "/organizations/:organizationId/webhooks/:webhookId",
    async (request, reply) => {
      const path = webhookPathSchema.safeParse(request.params);
      const body = webhookPatchSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid webhook update." },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const [current] = await transaction
            .select()
            .from(webhookSubscriptions)
            .where(
              and(
                eq(webhookSubscriptions.organizationId, context.organizationId),
                eq(webhookSubscriptions.id, path.data.webhookId),
              ),
            )
            .for("update")
            .limit(1);
          if (!current) return notFound();
          const nextStatus = body.data.status ?? current.status;
          if (nextStatus === "ACTIVE" && !current.signingSecretReference) {
            return response(409, {
              error: {
                code: "CONFLICT",
                message: "A signing secret must be configured before enabling.",
              },
            });
          }
          const [updated] = await transaction
            .update(webhookSubscriptions)
            .set({ ...body.data, updatedAt: new Date() })
            .where(
              and(
                eq(webhookSubscriptions.organizationId, context.organizationId),
                eq(webhookSubscriptions.id, current.id),
              ),
            )
            .returning();
          if (!updated) return notFound();
          if (updated.status === "DISABLED") {
            await cancelSubscriptionDeliveries(
              transaction,
              context.organizationId,
              updated.id,
              new Date(),
            );
          }
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "WEBHOOK_SUBSCRIPTION_UPDATED",
            "webhook_subscription",
            updated.id,
            { fields: Object.keys(body.data) },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "webhook_subscription",
            updated.id,
            Object.keys(body.data),
          );
          return response(200, { webhook: publicWebhook(updated) });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/webhooks/:webhookId/deliveries",
    async (request, reply) => {
      const path = webhookPathSchema.safeParse(request.params);
      const query = deliveryQuerySchema.safeParse(request.query);
      if (!path.success || !query.success)
        return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        integrationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const [subscription] = await transaction
            .select({ id: webhookSubscriptions.id })
            .from(webhookSubscriptions)
            .where(
              and(
                eq(webhookSubscriptions.organizationId, context.organizationId),
                eq(webhookSubscriptions.id, path.data.webhookId),
              ),
            )
            .limit(1);
          if (!subscription) return notFound();
          const deliveries = await transaction
            .select({
              id: webhookDeliveries.id,
              eventId: webhookDeliveries.eventId,
              eventType: webhookDeliveries.eventType,
              status: webhookDeliveries.status,
              attemptCount: webhookDeliveries.attemptCount,
              maxAttempts: webhookDeliveries.maxAttempts,
              nextAttemptAt: webhookDeliveries.nextAttemptAt,
              lastHttpStatus: webhookDeliveries.lastHttpStatus,
              lastFailureCode: webhookDeliveries.lastFailureCode,
              createdAt: webhookDeliveries.createdAt,
              updatedAt: webhookDeliveries.updatedAt,
              completedAt: webhookDeliveries.completedAt,
            })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.organizationId, context.organizationId),
                eq(webhookDeliveries.subscriptionId, subscription.id),
              ),
            )
            .orderBy(asc(webhookDeliveries.createdAt))
            .limit(query.data.limit);
          return response(200, { deliveries });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/webhooks/:webhookId/deliveries/:deliveryId/attempts",
    async (request, reply) => {
      const path = deliveryAttemptPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        integrationsRead,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const [delivery] = await transaction
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.organizationId, context.organizationId),
                eq(webhookDeliveries.subscriptionId, path.data.webhookId),
                eq(webhookDeliveries.id, path.data.deliveryId),
              ),
            )
            .limit(1);
          if (!delivery) return notFound();
          const attempts = await transaction
            .select({
              id: webhookDeliveryAttempts.id,
              attemptNumber: webhookDeliveryAttempts.attemptNumber,
              status: webhookDeliveryAttempts.status,
              httpStatus: webhookDeliveryAttempts.httpStatus,
              failureCode: webhookDeliveryAttempts.failureCode,
              responseMetadata: webhookDeliveryAttempts.responseMetadata,
              createdAt: webhookDeliveryAttempts.createdAt,
              completedAt: webhookDeliveryAttempts.completedAt,
            })
            .from(webhookDeliveryAttempts)
            .where(
              and(
                eq(
                  webhookDeliveryAttempts.organizationId,
                  context.organizationId,
                ),
                eq(webhookDeliveryAttempts.deliveryId, delivery.id),
              ),
            )
            .orderBy(asc(webhookDeliveryAttempts.attemptNumber));
          return response(200, { attempts });
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/webhooks/:webhookId/rotate-secret",
    async (request, reply) => {
      const path = webhookPathSchema.safeParse(request.params);
      const body = signingSecretSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "A valid signing secret is required.",
          },
        });
      }
      let createdReference: SecretReference | undefined;
      let previousReference: string | null = null;
      try {
        const result = await authorization.withPermission(
          requestContext(request),
          integrationsManage,
          { requestId: request.id },
          async (transaction, context) => {
            if (context.organizationId !== path.data.organizationId) {
              return notFound();
            }
            const [current] = await transaction
              .select()
              .from(webhookSubscriptions)
              .where(
                and(
                  eq(
                    webhookSubscriptions.organizationId,
                    context.organizationId,
                  ),
                  eq(webhookSubscriptions.id, path.data.webhookId),
                ),
              )
              .for("update")
              .limit(1);
            if (!current) return notFound();
            try {
              createdReference = current.signingSecretReference
                ? await rotateSecret(
                    secretStore,
                    context.organizationId,
                    "WEBHOOK_SIGNING",
                    current.signingSecretReference,
                    body.data.signingSecret,
                  )
                : await storeSecret(
                    secretStore,
                    context.organizationId,
                    "WEBHOOK_SIGNING",
                    body.data.signingSecret,
                  );
            } catch {
              return backendUnavailable();
            }
            previousReference = current.signingSecretReference;
            const [updated] = await transaction
              .update(webhookSubscriptions)
              .set({
                signingSecretReference: createdReference,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(
                    webhookSubscriptions.organizationId,
                    context.organizationId,
                  ),
                  eq(webhookSubscriptions.id, current.id),
                ),
              )
              .returning();
            if (!updated) return notFound();
            await writeAuthorizationMutationEvent(
              transaction,
              context,
              { requestId: request.id },
              "WEBHOOK_SECRET_ROTATED",
              "webhook_subscription",
              updated.id,
              { secretRotated: true },
            );
            await recordConfigurationChangedEvent(
              transaction,
              context,
              request.id,
              "webhook_subscription",
              updated.id,
              ["signingSecretRotated"],
            );
            return response(200, { webhook: publicWebhook(updated) });
          },
        );
        if (!result.allowed) return denied(reply, result.statusCode);
        if (result.value.statusCode >= 400 && createdReference) {
          await bestEffortDeleteSecret(
            secretStore,
            path.data.organizationId,
            "WEBHOOK_SIGNING",
            createdReference,
          );
        }
        if (
          result.value.statusCode < 400 &&
          previousReference &&
          previousReference !== createdReference
        ) {
          await bestEffortDeleteSecret(
            secretStore,
            path.data.organizationId,
            "WEBHOOK_SIGNING",
            secretReference(previousReference),
          );
        }
        return sendResponse(reply, result.value);
      } catch (error) {
        if (createdReference) {
          await bestEffortDeleteSecret(
            secretStore,
            path.data.organizationId,
            "WEBHOOK_SIGNING",
            createdReference,
          );
        }
        if (error instanceof IntegrationBackendUnavailableError) {
          return sendResponse(reply, backendUnavailable());
        }
        throw error;
      }
    },
  );

  app.delete(
    "/organizations/:organizationId/webhooks/:webhookId",
    async (request, reply) => {
      const path = webhookPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        integrationsManage,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const [current] = await transaction
            .select()
            .from(webhookSubscriptions)
            .where(
              and(
                eq(webhookSubscriptions.organizationId, context.organizationId),
                eq(webhookSubscriptions.id, path.data.webhookId),
              ),
            )
            .for("update")
            .limit(1);
          if (!current) return notFound();
          if (current.signingSecretReference) {
            try {
              await deleteSecret(
                secretStore,
                context.organizationId,
                "WEBHOOK_SIGNING",
                current.signingSecretReference,
              );
            } catch {
              return backendUnavailable();
            }
          }
          await transaction
            .update(webhookSubscriptions)
            .set({
              status: "DISABLED",
              signingSecretReference: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(webhookSubscriptions.organizationId, context.organizationId),
                eq(webhookSubscriptions.id, current.id),
              ),
            );
          await cancelSubscriptionDeliveries(
            transaction,
            context.organizationId,
            current.id,
            new Date(),
          );
          await writeAuthorizationMutationEvent(
            transaction,
            context,
            { requestId: request.id },
            "WEBHOOK_SUBSCRIPTION_DELETED",
            "webhook_subscription",
            current.id,
            { integrationId: current.integrationId },
          );
          await recordConfigurationChangedEvent(
            transaction,
            context,
            request.id,
            "webhook_subscription",
            current.id,
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
