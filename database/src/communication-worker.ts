import {
  communicationProviderResultSchema,
  type CommunicationChannel,
  type CommunicationProvider,
  type CommunicationProviderResult,
  type SecretReference,
  type SecretStore,
} from "@onecore/core-domain";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  auditLogs,
  communicationDeliveries,
  communicationDeliveryAttempts,
  communicationMessages,
  communicationProviderConfigs,
  integrations,
  organizationMemberships,
  organizations,
  users,
} from "../schema/index.js";
import type { Database } from "./index.js";
import { withOrganizationTransaction } from "./tenant-context.js";
import { calculateWebhookRetryDelay } from "./webhooks.js";

export interface CommunicationProviderRegistry {
  get(channel: Exclude<CommunicationChannel, "IN_APP">, providerKey: string):
    | CommunicationProvider
    | undefined;
}

export function createCommunicationProviderRegistry(
  providers: readonly CommunicationProvider[],
): CommunicationProviderRegistry {
  const entries = new Map<string, CommunicationProvider>();
  for (const provider of providers) {
    if (
      !/^[a-z][a-z0-9_.-]{2,79}$/.test(provider.providerKey)
    ) {
      throw new TypeError("Invalid communication provider contract");
    }
    const key = `${provider.channel}:${provider.providerKey}`;
    if (entries.has(key)) {
      throw new TypeError("Duplicate communication provider contract");
    }
    entries.set(key, provider);
  }
  return {
    get: (channel, providerKey) => entries.get(`${channel}:${providerKey}`),
  };
}

export interface CommunicationRecipientResolver {
  resolve(input: {
    organizationId: string;
    userId: string;
    channel: Exclude<CommunicationChannel, "IN_APP">;
    email: string;
  }): Promise<string | undefined>;
}

export const emailOnlyRecipientResolver: CommunicationRecipientResolver = {
  async resolve(input) {
    return input.channel === "EMAIL" ? input.email : undefined;
  },
};

export interface CommunicationWorkerOptions {
  batchSize?: number;
  leaseMilliseconds?: number;
  baseDelayMilliseconds?: number;
  maxDelayMilliseconds?: number;
  now?: Date;
}

export interface CommunicationWorkerResult {
  claimed: number;
  sent: number;
  delivered: number;
  retrying: number;
  failed: number;
  deadLettered: number;
  skipped: number;
}

export interface CommunicationDeliveryWorker {
  processTenantBatch(
    organizationId: string,
    requestedOptions?: CommunicationWorkerOptions,
  ): Promise<CommunicationWorkerResult | undefined>;
}

interface DeliveryClaim {
  deliveryId: string;
  organizationId: string;
  messageId: string;
  leaseToken: string;
  attemptNumber: number;
  maxAttempts: number;
}

interface LoadedDelivery extends DeliveryClaim {
  channel: Exclude<CommunicationChannel, "IN_APP">;
  recipientUserId: string;
  recipientEmail: string;
  subject: string | null;
  body: string;
  providerKey: string;
  providerConfiguration: Record<string, unknown>;
  secretReference: SecretReference;
  idempotencyKey: string;
}

interface CommunicationWorkerOptionsResolved {
  batchSize: number;
  leaseMilliseconds: number;
  baseDelayMilliseconds: number;
  maxDelayMilliseconds: number;
  now: Date;
}

function resolveOptions(
  options: CommunicationWorkerOptions,
): CommunicationWorkerOptionsResolved {
  const resolved = {
    batchSize: options.batchSize ?? 10,
    leaseMilliseconds: options.leaseMilliseconds ?? 60_000,
    baseDelayMilliseconds: options.baseDelayMilliseconds ?? 1_000,
    maxDelayMilliseconds: options.maxDelayMilliseconds ?? 3_600_000,
    now: options.now ?? new Date(),
  };
  if (
    !Number.isInteger(resolved.batchSize) ||
    resolved.batchSize < 1 ||
    resolved.batchSize > 100 ||
    !Number.isInteger(resolved.leaseMilliseconds) ||
    resolved.leaseMilliseconds < 1_000 ||
    resolved.leaseMilliseconds > 900_000 ||
    !Number.isFinite(resolved.baseDelayMilliseconds) ||
    resolved.baseDelayMilliseconds < 100 ||
    !Number.isFinite(resolved.maxDelayMilliseconds) ||
    resolved.maxDelayMilliseconds < resolved.baseDelayMilliseconds ||
    resolved.maxDelayMilliseconds > 86_400_000
  ) {
    throw new RangeError("Invalid communication worker options");
  }
  return resolved;
}

function retryDelay(
  attempt: number,
  deliveryId: string,
  result: CommunicationProviderResult,
  options: CommunicationWorkerOptionsResolved,
): number {
  const backoff = calculateWebhookRetryDelay(
    attempt,
    deliveryId,
    options.baseDelayMilliseconds,
    options.maxDelayMilliseconds,
  );
  if (result.outcome !== "RATE_LIMITED") return backoff;
  return Math.max(
    backoff,
    Math.min(
      (result.retryAfterSeconds ?? 0) * 1_000,
      options.maxDelayMilliseconds,
    ),
  );
}

function secretReference(value: string): SecretReference {
  return value as SecretReference;
}

async function writeDeadLetterAudit(
  transaction: Parameters<Parameters<typeof withOrganizationTransaction>[2]>[0],
  claim: DeliveryClaim,
  failureCode: string,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: claim.organizationId,
    action: "COMMUNICATION_DELIVERY_DEAD_LETTERED",
    resource: "communication_delivery",
    resourceId: claim.deliveryId,
    result: "FAILURE",
    requestMetadata: {
      messageId: claim.messageId,
      attempt: claim.attemptNumber,
      failureCode,
    },
  });
}

async function claimBatch(
  database: Database,
  organizationId: string,
  options: CommunicationWorkerOptionsResolved,
): Promise<DeliveryClaim[] | undefined> {
  return withOrganizationTransaction(database, organizationId, async (transaction) => {
    const [organization] = await transaction
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!organization || organization.status !== "ACTIVE") return undefined;

    const eligible = await transaction
      .select()
      .from(communicationDeliveries)
      .where(
        and(
          eq(communicationDeliveries.organizationId, organizationId),
          lte(communicationDeliveries.nextAttemptAt, options.now),
          or(
            inArray(communicationDeliveries.status, ["QUEUED", "RETRYING"]),
            and(
              eq(communicationDeliveries.status, "SENDING"),
              lte(communicationDeliveries.leaseExpiresAt, options.now),
            ),
          ),
        ),
      )
      .orderBy(asc(communicationDeliveries.nextAttemptAt), asc(communicationDeliveries.createdAt))
      .limit(options.batchSize)
      .for("update", { skipLocked: true });

    const claims: DeliveryClaim[] = [];
    for (const delivery of eligible) {
      if (delivery.status === "SENDING") {
        await transaction
          .update(communicationDeliveryAttempts)
          .set({
            status: "FAILED",
            failureClass: "RETRYABLE",
            failureCode: "WORKER_LEASE_EXPIRED",
            completedAt: options.now,
          })
          .where(
            and(
              eq(communicationDeliveryAttempts.organizationId, organizationId),
              eq(communicationDeliveryAttempts.deliveryId, delivery.id),
              eq(communicationDeliveryAttempts.attemptNumber, delivery.attemptCount),
              eq(communicationDeliveryAttempts.status, "SENDING"),
            ),
          );
      }
      if (delivery.attemptCount >= delivery.maxAttempts) {
        await transaction
          .update(communicationDeliveries)
          .set({
            status: "DEAD_LETTER",
            lastFailureClass: "RETRYABLE",
            lastFailureCode: "MAX_ATTEMPTS_EXHAUSTED",
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt: options.now,
            updatedAt: options.now,
          })
          .where(eq(communicationDeliveries.id, delivery.id));
        await transaction
          .update(communicationMessages)
          .set({ status: "DEAD_LETTER", completedAt: options.now, updatedAt: options.now })
          .where(eq(communicationMessages.id, delivery.messageId));
        await writeDeadLetterAudit(
          transaction,
          {
            deliveryId: delivery.id,
            messageId: delivery.messageId,
            organizationId,
            leaseToken: delivery.leaseToken ?? "",
            attemptNumber: delivery.attemptCount,
            maxAttempts: delivery.maxAttempts,
          },
          "MAX_ATTEMPTS_EXHAUSTED",
        );
        continue;
      }

      const attemptNumber = delivery.attemptCount + 1;
      const leaseToken = randomUUID();
      await transaction
        .update(communicationDeliveries)
        .set({
          status: "SENDING",
          attemptCount: attemptNumber,
          leaseToken,
          leaseExpiresAt: new Date(options.now.getTime() + options.leaseMilliseconds),
          updatedAt: options.now,
        })
        .where(eq(communicationDeliveries.id, delivery.id));
      await transaction
        .update(communicationMessages)
        .set({ status: "SENDING", updatedAt: options.now })
        .where(
          and(
            eq(communicationMessages.organizationId, organizationId),
            eq(communicationMessages.id, delivery.messageId),
          ),
        );
      await transaction.insert(communicationDeliveryAttempts).values({
        organizationId,
        deliveryId: delivery.id,
        attemptNumber,
        status: "SENDING",
      });
      claims.push({
        deliveryId: delivery.id,
        organizationId,
        messageId: delivery.messageId,
        leaseToken,
        attemptNumber,
        maxAttempts: delivery.maxAttempts,
      });
    }
    return claims;
  });
}

async function loadClaim(
  database: Database,
  claim: DeliveryClaim,
): Promise<LoadedDelivery | undefined> {
  return withOrganizationTransaction(database, claim.organizationId, async (transaction) => {
    const [row] = await transaction
      .select({
        deliveryStatus: communicationDeliveries.status,
        deliveryLeaseToken: communicationDeliveries.leaseToken,
        messageId: communicationMessages.id,
        channel: communicationMessages.channel,
        recipientUserId: communicationMessages.recipientUserId,
        subject: communicationMessages.subject,
        body: communicationMessages.renderedContent,
        providerConfigId: communicationDeliveries.providerConfigId,
        providerKey: communicationProviderConfigs.providerKey,
        providerStatus: communicationProviderConfigs.status,
        configuration: communicationProviderConfigs.configuration,
        secretReference: integrations.secretReference,
        integrationStatus: integrations.status,
        email: users.email,
        idempotencyKey: communicationMessages.idempotencyKey,
      })
      .from(communicationDeliveries)
      .innerJoin(
        communicationMessages,
        and(
          eq(communicationMessages.organizationId, communicationDeliveries.organizationId),
          eq(communicationMessages.id, communicationDeliveries.messageId),
        ),
      )
      .leftJoin(
        communicationProviderConfigs,
        and(
          eq(communicationProviderConfigs.organizationId, communicationDeliveries.organizationId),
          eq(communicationProviderConfigs.id, communicationDeliveries.providerConfigId),
        ),
      )
      .leftJoin(
        integrations,
        and(
          eq(integrations.organizationId, communicationProviderConfigs.organizationId),
          eq(integrations.id, communicationProviderConfigs.integrationId),
        ),
      )
      .innerJoin(
        organizationMemberships,
        and(
          eq(organizationMemberships.organizationId, communicationMessages.organizationId),
          eq(organizationMemberships.userId, communicationMessages.recipientUserId),
          eq(organizationMemberships.status, "ACTIVE"),
        ),
      )
      .innerJoin(
        users,
        and(
          eq(users.id, communicationMessages.recipientUserId),
          eq(users.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(communicationDeliveries.organizationId, claim.organizationId),
          eq(communicationDeliveries.id, claim.deliveryId),
          eq(communicationDeliveries.leaseToken, claim.leaseToken),
          eq(communicationDeliveries.status, "SENDING"),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.messageId !== claim.messageId ||
      row.deliveryStatus !== "SENDING" ||
      row.deliveryLeaseToken !== claim.leaseToken ||
      row.channel === "IN_APP" ||
      !row.providerConfigId ||
      !row.providerKey ||
      row.providerStatus !== "ACTIVE" ||
      !row.configuration ||
      !row.secretReference ||
      !["PENDING", "ACTIVE"].includes(row.integrationStatus ?? "") ||
      !row.idempotencyKey
    ) {
      return undefined;
    }
    return {
      ...claim,
      channel: row.channel,
      recipientUserId: row.recipientUserId,
      recipientEmail: row.email,
      subject: row.subject,
      body: row.body,
      providerKey: row.providerKey,
      providerConfiguration: row.configuration,
      secretReference: secretReference(row.secretReference),
      idempotencyKey: row.idempotencyKey,
    };
  });
}

interface AttemptOutcome {
  result: CommunicationProviderResult;
  failureClass: "RETRYABLE" | "PERMANENT" | "RATE_LIMITED" | null;
}

async function sendClaim(
  claim: LoadedDelivery,
  secretStore: SecretStore,
  providers: CommunicationProviderRegistry,
  recipientResolver: CommunicationRecipientResolver,
): Promise<AttemptOutcome> {
  const provider = providers.get(claim.channel, claim.providerKey);
  if (!provider || provider.channel !== claim.channel) {
    return {
      result: { outcome: "PERMANENT_FAILURE", failureCode: "PROVIDER_ADAPTER_UNAVAILABLE" },
      failureClass: "PERMANENT",
    };
  }
  let configurationValid = false;
  try {
    configurationValid = provider.validateConfiguration(claim.providerConfiguration);
  } catch {
    configurationValid = false;
  }
  if (!configurationValid) {
    return {
      result: { outcome: "PERMANENT_FAILURE", failureCode: "PROVIDER_CONFIGURATION_INVALID" },
      failureClass: "PERMANENT",
    };
  }
  let address: string | undefined;
  try {
    address = await recipientResolver.resolve({
      organizationId: claim.organizationId,
      userId: claim.recipientUserId,
      channel: claim.channel,
      email: claim.recipientEmail,
    });
  } catch {
    return {
      result: { outcome: "PERMANENT_FAILURE", failureCode: "RECIPIENT_RESOLUTION_FAILED" },
      failureClass: "PERMANENT",
    };
  }
  if (!address) {
    return {
      result: { outcome: "PERMANENT_FAILURE", failureCode: "RECIPIENT_ADDRESS_UNAVAILABLE" },
      failureClass: "PERMANENT",
    };
  }
  try {
    const providerResult = await secretStore.withSecret(
      {
        organizationId: claim.organizationId,
        purpose: "INTEGRATION_CREDENTIAL",
        reference: claim.secretReference,
      },
      (credential) =>
        provider.send(
          {
            channel: claim.channel,
            deliveryId: claim.deliveryId,
            idempotencyKey: claim.deliveryId,
            recipient: { userId: claim.recipientUserId, address },
            subject: claim.subject,
            body: claim.body,
            configuration: claim.providerConfiguration,
          },
          credential,
        ),
    );
    if (!providerResult) {
      return {
        result: { outcome: "RETRYABLE_FAILURE", failureCode: "SECRET_BACKEND_UNAVAILABLE" },
        failureClass: "RETRYABLE",
      };
    }
    const parsed = communicationProviderResultSchema.safeParse(providerResult);
    if (!parsed.success) {
      return {
        result: { outcome: "PERMANENT_FAILURE", failureCode: "PROVIDER_RESPONSE_INVALID" },
        failureClass: "PERMANENT",
      };
    }
    return {
      result: parsed.data,
      failureClass:
        parsed.data.outcome === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : parsed.data.outcome === "RETRYABLE_FAILURE"
            ? "RETRYABLE"
            : parsed.data.outcome === "PERMANENT_FAILURE"
              ? "PERMANENT"
              : null,
    };
  } catch {
    return {
      result: { outcome: "RETRYABLE_FAILURE", failureCode: "PROVIDER_CALL_FAILED" },
      failureClass: "RETRYABLE",
    };
  }
}

async function completeAttempt(
  database: Database,
  claim: LoadedDelivery,
  outcome: AttemptOutcome,
  options: CommunicationWorkerOptionsResolved,
): Promise<
  | "sent"
  | "delivered"
  | "retrying"
  | "failed"
  | "deadLettered"
  | "skipped"
> {
  return withOrganizationTransaction(database, claim.organizationId, async (transaction) => {
    const [current] = await transaction
      .select({
        status: communicationDeliveries.status,
        leaseToken: communicationDeliveries.leaseToken,
      })
      .from(communicationDeliveries)
      .where(
        and(
          eq(communicationDeliveries.organizationId, claim.organizationId),
          eq(communicationDeliveries.id, claim.deliveryId),
          eq(communicationDeliveries.status, "SENDING"),
          eq(communicationDeliveries.leaseToken, claim.leaseToken),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) return "skipped";

    const retryable = outcome.failureClass === "RETRYABLE" || outcome.failureClass === "RATE_LIMITED";
    const retryExhausted = retryable && claim.attemptNumber >= claim.maxAttempts;
    const nextStatus =
      outcome.result.outcome === "DELIVERED"
        ? "DELIVERED"
        : outcome.result.outcome === "SENT"
          ? "SENT"
          : retryable && !retryExhausted
            ? "RETRYING"
            : retryExhausted
              ? "DEAD_LETTER"
              : "FAILED";
    const failureCode = retryExhausted
      ? "MAX_ATTEMPTS_EXHAUSTED"
      : outcome.result.failureCode ?? null;
    const nextAttemptAt =
      nextStatus === "RETRYING"
        ? new Date(
            options.now.getTime() +
              retryDelay(claim.attemptNumber, claim.deliveryId, outcome.result, options),
          )
        : options.now;
    await transaction
      .update(communicationDeliveryAttempts)
      .set({
        status:
          nextStatus === "DEAD_LETTER"
            ? "DEAD_LETTER"
            : nextStatus === "FAILED"
              ? "FAILED"
              : nextStatus,
        providerMessageId: outcome.result.providerMessageId ?? null,
        failureClass: outcome.failureClass,
        failureCode,
        retryAfterSeconds: outcome.result.retryAfterSeconds ?? null,
        completedAt: options.now,
      })
      .where(
        and(
          eq(communicationDeliveryAttempts.organizationId, claim.organizationId),
          eq(communicationDeliveryAttempts.deliveryId, claim.deliveryId),
          eq(communicationDeliveryAttempts.attemptNumber, claim.attemptNumber),
          eq(communicationDeliveryAttempts.status, "SENDING"),
        ),
      );
    await transaction
      .update(communicationDeliveries)
      .set({
        status: nextStatus,
        providerMessageId: outcome.result.providerMessageId ?? null,
        nextAttemptAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastFailureClass: outcome.failureClass,
        lastFailureCode: failureCode,
        retryAfterSeconds: outcome.result.retryAfterSeconds ?? null,
        completedAt:
          nextStatus === "RETRYING" ? null : options.now,
        updatedAt: options.now,
      })
      .where(eq(communicationDeliveries.id, claim.deliveryId));
    await transaction
      .update(communicationMessages)
      .set({
        status: nextStatus,
        renderedContent: nextStatus === "RETRYING" ? undefined : "",
        completedAt: nextStatus === "RETRYING" ? null : options.now,
        updatedAt: options.now,
      })
      .where(eq(communicationMessages.id, claim.messageId));

    if (nextStatus === "DEAD_LETTER" || nextStatus === "FAILED") {
      await transaction.insert(auditLogs).values({
        organizationId: claim.organizationId,
        action:
          nextStatus === "DEAD_LETTER"
            ? "COMMUNICATION_DELIVERY_DEAD_LETTERED"
            : "COMMUNICATION_DELIVERY_FAILED",
        resource: "communication_delivery",
        resourceId: claim.deliveryId,
        result: "FAILURE",
        requestMetadata: {
          messageId: claim.messageId,
          attempt: claim.attemptNumber,
          failureClass: outcome.failureClass,
          failureCode,
        },
      });
    }
    switch (nextStatus) {
      case "SENT":
        return "sent";
      case "DELIVERED":
        return "delivered";
      case "RETRYING":
        return "retrying";
      case "FAILED":
        return "failed";
      case "DEAD_LETTER":
        return "deadLettered";
      default:
        return "skipped";
    }
  });
}

export function createCommunicationDeliveryWorker(
  database: Database,
  secretStore: SecretStore,
  providers: CommunicationProviderRegistry,
  recipientResolver: CommunicationRecipientResolver = emailOnlyRecipientResolver,
): CommunicationDeliveryWorker {
  return {
    async processTenantBatch(
      organizationId: string,
      requestedOptions: CommunicationWorkerOptions = {},
    ): Promise<CommunicationWorkerResult | undefined> {
      const tenantId = organizationId.toLowerCase();
      if (!/^[0-9a-f-]{36}$/.test(tenantId)) {
        throw new TypeError("Invalid communication worker tenant");
      }
      const options = resolveOptions(requestedOptions);
      const claims = await claimBatch(database, tenantId, options);
      if (claims === undefined) return undefined;
      const result: CommunicationWorkerResult = {
        claimed: claims.length,
        sent: 0,
        delivered: 0,
        retrying: 0,
        failed: 0,
        deadLettered: 0,
        skipped: 0,
      };
      for (const claim of claims) {
        const loaded = await loadClaim(database, claim);
        if (!loaded) {
          result.skipped += 1;
          continue;
        }
        const outcome = await sendClaim(loaded, secretStore, providers, recipientResolver);
        const completed = await completeAttempt(database, loaded, outcome, options);
        if (completed === "skipped") result.skipped += 1;
        else {
          result[completed] += 1;
        }
      }
      return result;
    },
  };
}