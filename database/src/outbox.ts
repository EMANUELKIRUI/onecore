import { parseDomainEvent, type EventEnvelope } from "@onecore/core-domain";
import { auditLogs, outboxEvents } from "../schema/index.js";
import type { OrganizationTransaction } from "./tenant-context.js";

export type DomainEvent = EventEnvelope;

export async function recordOutboxEvent(
  transaction: OrganizationTransaction,
  input: unknown,
): Promise<EventEnvelope> {
  const event = parseDomainEvent(input);
  await transaction.insert(outboxEvents).values({
    id: event.eventId,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    organizationId: event.organizationId,
    branchId: event.branchId ?? null,
    actorUserId: event.actorUserId ?? null,
    correlationId: event.correlationId,
    causationId: event.causationId ?? null,
    occurredAt: event.occurredAt,
    payload: event.payload,
    metadata: event.metadata,
    version: event.eventVersion,
    deliveryStatus: "PENDING",
    nextAttemptAt: new Date(),
  });
  await transaction.insert(auditLogs).values({
    organizationId: event.organizationId,
    actorUserId: event.actorUserId ?? null,
    action: "EVENT_CREATED",
    resource: "outbox_event",
    resourceId: event.eventId,
    result: "SUCCESS",
    requestMetadata: {
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      branchId: event.branchId ?? null,
      correlationId: event.correlationId,
      causationId: event.causationId ?? null,
    },
  });
  return event;
}
