import { randomUUID } from "node:crypto";
import {
  parseDomainEvent,
  type SecretReference,
  type SecretStore,
  type WebhookAttemptStatus,
  type WebhookDeliveryStatus,
} from "@onecore/core-domain";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import {
  auditLogs,
  calculateWebhookRetryDelay,
  classifyWebhookHttpStatus,
  integrations,
  outboxEvents,
  organizations,
  webhookDeliveryAttempts,
  webhookDeliveries,
  webhookSubscriptions,
  withOrganizationTransaction,
  type Database,
  type OrganizationTransaction,
} from "@onecore/database";
import {
  failClosedWebhookTransport,
  IntegrationBackendUnavailableError,
  unavailableSecretStore,
  type OutboundWebhookResponse,
  type OutboundWebhookTransport,
} from "./integration-boundaries.js";
import {
  signWebhookPayload,
  WEBHOOK_PAYLOAD_MAX_BYTES,
} from "./webhook-signing.js";
import { validateWebhookEndpoint } from "./webhook-endpoint.js";

export interface WebhookDeliveryWorkerOptions {
  batchSize?: number;
  leaseMilliseconds?: number;
  baseDelayMilliseconds?: number;
  maxDelayMilliseconds?: number;
  now?: Date;
}

export interface WebhookDeliveryWorkerResult {
  claimed: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
  cancelled: number;
}

export interface WebhookDeliveryClaim {
  deliveryId: string;
  organizationId: string;
  subscriptionId: string;
  eventId: string;
  endpointUrl: string;
  signingSecretReference: string;
  attemptNumber: number;
  maxAttempts: number;
  leaseToken: string;
  payload: Uint8Array;
}

interface WebhookClaimBatch {
  claims: WebhookDeliveryClaim[];
  cancelled: number;
  deadLettered: number;
}

export interface WebhookAttemptResult {
  status: Exclude<WebhookAttemptStatus, "IN_PROGRESS">;
  httpStatus: number | null;
  failureCode: string | null;
  responseMetadata: Record<string, string>;
}

export interface WebhookAttemptTransition {
  deliveryStatus: Extract<
    WebhookDeliveryStatus,
    "DELIVERED" | "RETRYING" | "DEAD_LETTERED"
  >;
  attemptStatus: Exclude<WebhookAttemptStatus, "IN_PROGRESS">;
  failureCode: string | null;
}

export function resolveWebhookAttemptTransition(
  result: WebhookAttemptResult,
  attemptNumber: number,
  maxAttempts: number,
): WebhookAttemptTransition {
  if (
    !Number.isInteger(attemptNumber) ||
    attemptNumber < 1 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20 ||
    attemptNumber > maxAttempts
  ) {
    throw new RangeError("Invalid webhook attempt transition");
  }
  if (result.status === "DELIVERED") {
    return {
      deliveryStatus: "DELIVERED",
      attemptStatus: "DELIVERED",
      failureCode: null,
    };
  }
  if (result.status === "RETRYING" && attemptNumber < maxAttempts) {
    return {
      deliveryStatus: "RETRYING",
      attemptStatus: "RETRYING",
      failureCode: result.failureCode,
    };
  }
  return {
    deliveryStatus: "DEAD_LETTERED",
    attemptStatus: result.status === "RETRYING" ? "DEAD_LETTERED" : "FAILED",
    failureCode:
      result.status === "RETRYING"
        ? "MAX_ATTEMPTS_EXHAUSTED"
        : result.failureCode,
  };
}

export function webhookIntegrationAllowsDelivery(status: string): boolean {
  return status === "PENDING" || status === "ACTIVE";
}

const allowedResponseMetadata = new Set(["content-type", "retry-after"]);

function safeResponseMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = value.trim().slice(0, 256);
    if (!allowedResponseMetadata.has(normalizedKey)) continue;
    if (normalizedKey === "content-type") {
      const mediaType = normalizedValue.split(";", 1)[0]?.trim().toLowerCase();
      if (
        mediaType &&
        /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
      ) {
        safe[normalizedKey] = mediaType;
      }
    } else if (/^\d{1,9}$/.test(normalizedValue)) {
      safe[normalizedKey] = normalizedValue;
    }
  }
  return safe;
}

function secretReference(value: string): SecretReference {
  return value as SecretReference;
}

function eventEnvelopeFromRow(row: typeof outboxEvents.$inferSelect) {
  if (!row.organizationId) throw new TypeError("EVENT_ORGANIZATION_REQUIRED");
  return parseDomainEvent({
    eventId: row.id,
    eventType: row.eventType,
    eventVersion: row.version,
    occurredAt: row.occurredAt,
    organizationId: row.organizationId,
    ...(row.branchId ? { branchId: row.branchId } : {}),
    ...(row.actorUserId ? { actorUserId: row.actorUserId } : {}),
    correlationId: row.correlationId,
    ...(row.causationId ? { causationId: row.causationId } : {}),
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    metadata: row.metadata,
  });
}

function normalizedOptions(options: WebhookDeliveryWorkerOptions) {
  const normalized = {
    batchSize: options.batchSize ?? 10,
    leaseMilliseconds: options.leaseMilliseconds ?? 60_000,
    baseDelayMilliseconds: options.baseDelayMilliseconds ?? 1_000,
    maxDelayMilliseconds: options.maxDelayMilliseconds ?? 3_600_000,
    now: options.now ?? new Date(),
  };
  if (
    !Number.isInteger(normalized.batchSize) ||
    normalized.batchSize < 1 ||
    normalized.batchSize > 100 ||
    !Number.isInteger(normalized.leaseMilliseconds) ||
    normalized.leaseMilliseconds < 1_000 ||
    normalized.leaseMilliseconds > 900_000 ||
    !Number.isFinite(normalized.baseDelayMilliseconds) ||
    normalized.baseDelayMilliseconds < 100 ||
    !Number.isFinite(normalized.maxDelayMilliseconds) ||
    normalized.maxDelayMilliseconds < normalized.baseDelayMilliseconds ||
    normalized.maxDelayMilliseconds > 86_400_000
  ) {
    throw new RangeError("Invalid webhook delivery worker configuration");
  }
  return normalized;
}

export async function performWebhookDeliveryAttempt(
  claim: WebhookDeliveryClaim,
  secretStore: SecretStore,
  transport: OutboundWebhookTransport,
  now = new Date(),
): Promise<WebhookAttemptResult> {
  if (transport.securityPolicy !== "SSRF_SAFE") {
    return {
      status: "FAILED",
      httpStatus: null,
      failureCode: "UNSAFE_TRANSPORT_REJECTED",
      responseMetadata: {},
    };
  }
  if (claim.payload.byteLength > WEBHOOK_PAYLOAD_MAX_BYTES) {
    return {
      status: "FAILED",
      httpStatus: null,
      failureCode: "PAYLOAD_TOO_LARGE",
      responseMetadata: {},
    };
  }
  let endpointUrl: string;
  try {
    endpointUrl = validateWebhookEndpoint(claim.endpointUrl).href;
  } catch {
    return {
      status: "FAILED",
      httpStatus: null,
      failureCode: "DESTINATION_REJECTED",
      responseMetadata: {},
    };
  }

  let response: OutboundWebhookResponse | undefined;
  try {
    response = await secretStore.withSecret(
      {
        organizationId: claim.organizationId,
        purpose: "WEBHOOK_SIGNING",
        reference: secretReference(claim.signingSecretReference),
      },
      async (secret) => {
        const timestamp = Math.floor(now.getTime() / 1_000);
        const signature = signWebhookPayload({
          secret,
          deliveryId: claim.deliveryId,
          timestamp,
          payload: claim.payload,
        });
        return transport.send({
          endpointUrl,
          deliveryId: claim.deliveryId,
          timestamp,
          payload: claim.payload,
          signature,
        });
      },
    );
  } catch (error) {
    return {
      status: "RETRYING",
      httpStatus: null,
      failureCode:
        error instanceof IntegrationBackendUnavailableError
          ? `${error.backend}_UNAVAILABLE`
          : error instanceof TypeError
            ? "DELIVERY_INPUT_INVALID"
            : "NETWORK_FAILURE",
      responseMetadata: {},
    };
  }

  if (!response) {
    return {
      status: "FAILED",
      httpStatus: null,
      failureCode: "SIGNING_SECRET_NOT_FOUND",
      responseMetadata: {},
    };
  }
  let disposition: ReturnType<typeof classifyWebhookHttpStatus>;
  try {
    disposition = classifyWebhookHttpStatus(response.statusCode);
  } catch {
    return {
      status: "FAILED",
      httpStatus: null,
      failureCode: "INVALID_TRANSPORT_RESPONSE",
      responseMetadata: {},
    };
  }
  return {
    status:
      disposition === "DELIVERED"
        ? "DELIVERED"
        : disposition === "RETRY"
          ? "RETRYING"
          : "FAILED",
    httpStatus: response.statusCode,
    failureCode:
      disposition === "DELIVERED" ? null : `HTTP_${response.statusCode}`,
    responseMetadata: safeResponseMetadata(response.responseMetadata),
  };
}

async function writeDeadLetterAudit(
  transaction: OrganizationTransaction,
  input: {
    organizationId: string;
    deliveryId: string;
    subscriptionId: string;
    eventId: string;
    attemptCount: number;
    failureCode: string;
  },
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: input.organizationId,
    action: "WEBHOOK_DELIVERY_DEAD_LETTERED",
    resource: "webhook_delivery",
    resourceId: input.deliveryId,
    result: "FAILURE",
    requestMetadata: {
      subscriptionId: input.subscriptionId,
      eventId: input.eventId,
      attempts: input.attemptCount,
      failureCode: input.failureCode,
    },
  });
}

async function claimTenantBatch(
  database: Database,
  organizationId: string,
  options: ReturnType<typeof normalizedOptions>,
): Promise<WebhookClaimBatch | undefined> {
  return withOrganizationTransaction(
    database,
    organizationId,
    async (transaction) => {
      const [organization] = await transaction
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      if (!organization || organization.status !== "ACTIVE") return undefined;

      const eligible = await transaction
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.organizationId, organizationId),
            lte(webhookDeliveries.nextAttemptAt, options.now),
            or(
              inArray(webhookDeliveries.status, ["PENDING", "RETRYING"]),
              and(
                eq(webhookDeliveries.status, "PROCESSING"),
                lte(webhookDeliveries.leaseExpiresAt, options.now),
              ),
            ),
          ),
        )
        .orderBy(webhookDeliveries.nextAttemptAt, webhookDeliveries.createdAt)
        .limit(options.batchSize)
        .for("update", { skipLocked: true });

      const batch: WebhookClaimBatch = {
        claims: [],
        cancelled: 0,
        deadLettered: 0,
      };
      for (const delivery of eligible) {
        if (delivery.status === "PROCESSING" && delivery.attemptCount > 0) {
          await transaction
            .update(webhookDeliveryAttempts)
            .set({
              status: "RETRYING",
              failureCode: "WORKER_LEASE_EXPIRED",
              completedAt: options.now,
            })
            .where(
              and(
                eq(webhookDeliveryAttempts.organizationId, organizationId),
                eq(webhookDeliveryAttempts.deliveryId, delivery.id),
                eq(
                  webhookDeliveryAttempts.attemptNumber,
                  delivery.attemptCount,
                ),
                eq(webhookDeliveryAttempts.status, "IN_PROGRESS"),
              ),
            );
        }
        if (delivery.attemptCount >= delivery.maxAttempts) {
          await transaction
            .update(webhookDeliveries)
            .set({
              status: "DEAD_LETTERED",
              completedAt: options.now,
              leaseToken: null,
              leaseExpiresAt: null,
              lastFailureCode: "MAX_ATTEMPTS_EXHAUSTED",
              updatedAt: options.now,
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          await writeDeadLetterAudit(transaction, {
            organizationId,
            deliveryId: delivery.id,
            subscriptionId: delivery.subscriptionId,
            eventId: delivery.eventId,
            attemptCount: delivery.attemptCount,
            failureCode: "MAX_ATTEMPTS_EXHAUSTED",
          });
          batch.deadLettered += 1;
          continue;
        }

        const [subscription] = await transaction
          .select()
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, organizationId),
              eq(webhookSubscriptions.id, delivery.subscriptionId),
            ),
          )
          .limit(1);
        const [integration] = subscription
          ? await transaction
              .select({
                provider: integrations.provider,
                status: integrations.status,
              })
              .from(integrations)
              .where(
                and(
                  eq(integrations.organizationId, organizationId),
                  eq(integrations.id, subscription.integrationId),
                ),
              )
              .limit(1)
          : [];
        const [event] = await transaction
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.organizationId, organizationId),
              eq(outboxEvents.id, delivery.eventId),
            ),
          )
          .limit(1);

        if (
          !subscription ||
          subscription.status !== "ACTIVE" ||
          !subscription.signingSecretReference ||
          !subscription.eventTypes.includes(delivery.eventType) ||
          !integration ||
          integration.provider !== "WEBHOOK" ||
          !webhookIntegrationAllowsDelivery(integration.status) ||
          !event
        ) {
          await transaction
            .update(webhookDeliveries)
            .set({
              status: "CANCELLED",
              completedAt: options.now,
              leaseToken: null,
              leaseExpiresAt: null,
              lastFailureCode: "SUBSCRIPTION_OR_INTEGRATION_INACTIVE",
              updatedAt: options.now,
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          batch.cancelled += 1;
          continue;
        }

        let payload: Uint8Array;
        try {
          const envelope = eventEnvelopeFromRow(event);
          if (
            envelope.organizationId !== organizationId ||
            envelope.eventType !== delivery.eventType
          ) {
            throw new TypeError("DELIVERY_EVENT_MISMATCH");
          }
          payload = new TextEncoder().encode(JSON.stringify(envelope));
        } catch {
          await transaction
            .update(webhookDeliveries)
            .set({
              status: "DEAD_LETTERED",
              completedAt: options.now,
              leaseToken: null,
              leaseExpiresAt: null,
              lastFailureCode: "INVALID_EVENT_ENVELOPE",
              updatedAt: options.now,
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          await writeDeadLetterAudit(transaction, {
            organizationId,
            deliveryId: delivery.id,
            subscriptionId: delivery.subscriptionId,
            eventId: delivery.eventId,
            attemptCount: delivery.attemptCount,
            failureCode: "INVALID_EVENT_ENVELOPE",
          });
          batch.deadLettered += 1;
          continue;
        }

        const attemptNumber = delivery.attemptCount + 1;
        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(
          options.now.getTime() + options.leaseMilliseconds,
        );
        await transaction
          .update(webhookDeliveries)
          .set({
            status: "PROCESSING",
            attemptCount: attemptNumber,
            leaseToken,
            leaseExpiresAt,
            updatedAt: options.now,
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        await transaction.insert(webhookDeliveryAttempts).values({
          organizationId,
          deliveryId: delivery.id,
          attemptNumber,
          status: "IN_PROGRESS",
        });
        batch.claims.push({
          deliveryId: delivery.id,
          organizationId,
          subscriptionId: subscription.id,
          eventId: delivery.eventId,
          endpointUrl: subscription.endpointUrl,
          signingSecretReference: subscription.signingSecretReference,
          attemptNumber,
          maxAttempts: delivery.maxAttempts,
          leaseToken,
          payload,
        });
      }
      return batch;
    },
  );
}

async function completeClaim(
  database: Database,
  claim: WebhookDeliveryClaim,
  result: WebhookAttemptResult,
  options: ReturnType<typeof normalizedOptions>,
): Promise<WebhookDeliveryStatus | undefined> {
  return withOrganizationTransaction(
    database,
    claim.organizationId,
    async (transaction) => {
      const [delivery] = await transaction
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.organizationId, claim.organizationId),
            eq(webhookDeliveries.id, claim.deliveryId),
            eq(webhookDeliveries.leaseToken, claim.leaseToken),
            eq(webhookDeliveries.status, "PROCESSING"),
          ),
        )
        .for("update")
        .limit(1);
      if (!delivery) return undefined;

      const transition = resolveWebhookAttemptTransition(
        result,
        claim.attemptNumber,
        claim.maxAttempts,
      );
      const status = transition.deliveryStatus;
      const failureCode = transition.failureCode;
      const nextAttemptAt =
        status === "RETRYING"
          ? new Date(
              options.now.getTime() +
                calculateWebhookRetryDelay(
                  claim.attemptNumber,
                  claim.deliveryId,
                  options.baseDelayMilliseconds,
                  options.maxDelayMilliseconds,
                ),
            )
          : options.now;
      await transaction
        .update(webhookDeliveryAttempts)
        .set({
          status: transition.attemptStatus,
          httpStatus: result.httpStatus,
          failureCode: result.failureCode,
          completedAt: options.now,
          responseMetadata: result.responseMetadata,
        })
        .where(
          and(
            eq(webhookDeliveryAttempts.organizationId, claim.organizationId),
            eq(webhookDeliveryAttempts.deliveryId, claim.deliveryId),
            eq(webhookDeliveryAttempts.attemptNumber, claim.attemptNumber),
          ),
        );
      await transaction
        .update(webhookDeliveries)
        .set({
          status,
          nextAttemptAt,
          leaseToken: null,
          leaseExpiresAt: null,
          lastHttpStatus: result.httpStatus,
          lastFailureCode: failureCode,
          responseMetadata: result.responseMetadata,
          completedAt:
            status === "DELIVERED" || status === "DEAD_LETTERED"
              ? options.now
              : null,
          updatedAt: options.now,
        })
        .where(eq(webhookDeliveries.id, claim.deliveryId));

      if (status === "DEAD_LETTERED") {
        await writeDeadLetterAudit(transaction, {
          organizationId: claim.organizationId,
          deliveryId: claim.deliveryId,
          subscriptionId: claim.subscriptionId,
          eventId: claim.eventId,
          attemptCount: claim.attemptNumber,
          failureCode: failureCode ?? "DELIVERY_PERMANENT_FAILURE",
        });
      }
      return status;
    },
  );
}

export function createWebhookDeliveryWorker(
  database: Database,
  secretStore: SecretStore = unavailableSecretStore,
  transport: OutboundWebhookTransport = failClosedWebhookTransport,
) {
  return {
    async processTenantBatch(
      organizationId: string,
      requestedOptions: WebhookDeliveryWorkerOptions = {},
    ): Promise<WebhookDeliveryWorkerResult | undefined> {
      const normalizedOrganizationId = organizationId.toLowerCase();
      if (!/^[0-9a-f-]{36}$/.test(normalizedOrganizationId)) {
        throw new TypeError("Invalid webhook worker tenant");
      }
      const options = normalizedOptions(requestedOptions);
      const batch = await claimTenantBatch(
        database,
        normalizedOrganizationId,
        options,
      );
      if (batch === undefined) return undefined;

      const result: WebhookDeliveryWorkerResult = {
        claimed: batch.claims.length + batch.cancelled + batch.deadLettered,
        delivered: 0,
        retrying: 0,
        deadLettered: batch.deadLettered,
        cancelled: batch.cancelled,
      };
      for (const claim of batch.claims) {
        const attempt = await performWebhookDeliveryAttempt(
          claim,
          secretStore,
          transport,
          options.now,
        );
        const status = await completeClaim(database, claim, attempt, options);
        if (status === "DELIVERED") result.delivered += 1;
        else if (status === "RETRYING") result.retrying += 1;
        else if (status === "DEAD_LETTERED") result.deadLettered += 1;
        else if (status === "CANCELLED") result.cancelled += 1;
      }
      return result;
    },
  };
}
