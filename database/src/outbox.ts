import { outboxEvents } from "../schema/index.js";
import type { OrganizationTransaction } from "./tenant-context.js";

export interface DomainEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  organizationId: string | null;
  occurredAt: Date;
  payload: TPayload;
  version: number;
}

export async function recordOutboxEvent<
  TPayload extends Record<string, unknown>,
>(
  transaction: OrganizationTransaction,
  event: DomainEvent<TPayload>,
): Promise<void> {
  await transaction.insert(outboxEvents).values({
    id: event.eventId,
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    organizationId: event.organizationId,
    occurredAt: event.occurredAt,
    payload: event.payload,
    version: event.version,
  });
}
