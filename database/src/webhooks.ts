import { createHash } from "node:crypto";
import {
  eventRegistry,
  type EventEnvelope,
  type EventType,
} from "@onecore/core-domain";
import { and, eq, sql } from "drizzle-orm";
import { webhookDeliveries, webhookSubscriptions } from "../schema/index.js";
import type { EventHandler } from "./event-dispatcher.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import type { ResolvedAuthorizationContext } from "./authorization.js";

export type WebhookResponseDisposition = "DELIVERED" | "RETRY" | "PERMANENT";

export function classifyWebhookHttpStatus(
  statusCode: number,
): WebhookResponseDisposition {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new RangeError("HTTP status must be between 100 and 599");
  }
  if (statusCode >= 200 && statusCode < 300) return "DELIVERED";
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return "RETRY";
  }
  return "PERMANENT";
}

export function calculateWebhookRetryDelay(
  attempt: number,
  deliveryId: string,
  baseDelayMs = 1_000,
  maxDelayMs = 3_600_000,
): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 20) {
    throw new RangeError("Webhook retry attempt must be between 1 and 20");
  }
  if (
    !/^[0-9a-f-]{36}$/i.test(deliveryId) ||
    !Number.isFinite(baseDelayMs) ||
    baseDelayMs < 1 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < baseDelayMs
  ) {
    throw new RangeError("Invalid webhook retry configuration");
  }
  const jitterSeed = createHash("sha256")
    .update(`${deliveryId}:${attempt}`)
    .digest()
    .readUInt32BE(0);
  const jitter = 0.5 + jitterSeed / 0xffff_ffff;
  const exponential = Math.min(
    baseDelayMs * 2 ** Math.min(attempt - 1, 30),
    maxDelayMs,
  );
  return Math.min(Math.round(exponential * jitter), maxDelayMs);
}

export function webhookEventMatches(
  subscribedEventTypes: readonly string[],
  eventType: EventType,
): boolean {
  return subscribedEventTypes.includes(eventType);
}

function createWebhookEnqueueHandler(eventType: EventType): EventHandler {
  return {
    handlerName: `platform.webhook.enqueue.${eventType.toLowerCase()}`,
    eventType,
    eventVersion: eventRegistry[eventType].version,
    owningModule: "core.organization",
    requiredModuleEntitlement: null,
    requiredPermissionKey: null,
    async handle(
      transaction: OrganizationTransaction,
      event: EventEnvelope,
      context: ResolvedAuthorizationContext,
    ) {
      const subscriptions = await transaction
        .select({
          id: webhookSubscriptions.id,
          eventTypes: webhookSubscriptions.eventTypes,
        })
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.organizationId, context.organizationId),
            eq(webhookSubscriptions.status, "ACTIVE"),
            sql`${webhookSubscriptions.eventTypes} @> ${JSON.stringify([eventType])}::jsonb`,
          ),
        );

      for (const subscription of subscriptions) {
        if (!webhookEventMatches(subscription.eventTypes, eventType)) continue;
        await transaction
          .insert(webhookDeliveries)
          .values({
            organizationId: context.organizationId,
            subscriptionId: subscription.id,
            eventId: event.eventId,
            eventType,
            status: "PENDING",
          })
          .onConflictDoNothing({
            target: [
              webhookDeliveries.eventId,
              webhookDeliveries.subscriptionId,
            ],
          });
      }
    },
  };
}

export const platformWebhookEventHandlers = (
  Object.keys(eventRegistry) as EventType[]
).map(createWebhookEnqueueHandler);
