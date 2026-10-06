import { sql } from "drizzle-orm";
import { parseDomainEvent, type EventEnvelope } from "@onecore/core-domain";
import { auditLogs } from "../schema/index.js";
import type { OrganizationTransaction } from "./tenant-context.js";

export type DomainEvent = EventEnvelope;

export async function recordOutboxEvent(
  transaction: OrganizationTransaction,
  input: unknown,
): Promise<EventEnvelope> {
  const event = parseDomainEvent(input);
  await transaction.execute(sql`
    insert into outbox_events (
      id, event_type, aggregate_type, aggregate_id, organization_id, branch_id,
      actor_user_id, correlation_id, causation_id, occurred_at, payload,
      metadata, version, delivery_status, next_attempt_at
    ) values (
      ${event.eventId}, ${event.eventType}, ${event.aggregateType},
      ${event.aggregateId}, ${event.organizationId}, ${event.branchId ?? null},
      ${event.actorUserId ?? null}, ${event.correlationId},
      ${event.causationId ?? null}, ${event.occurredAt.toISOString()},
      ${JSON.stringify(event.payload)}::jsonb,
      ${JSON.stringify(event.metadata)}::jsonb, ${event.eventVersion},
      'PENDING', ${new Date().toISOString()}
    )
  `);
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
