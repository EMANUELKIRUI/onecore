import {
  eventFailureKindSchema,
  eventRegistry,
  parseDomainEvent,
  type EventEnvelope,
  type EventFailureKind,
  type EventProcessingStatus,
  type EventType,
} from "@onecore/core-domain";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  eventDeadLetters,
  eventProcessingRecords,
  outboxEvents,
  type AuthorizationContext,
  type AuthorizationMetadata,
  type AuthorizationResult,
  type AuthorizationService,
  type ResolvedAuthorizationContext,
} from "./index.js";
import { loadOrganizationModuleAccess } from "./module-entitlements.js";
import type { OrganizationTransaction } from "./tenant-context.js";

export const eventDispatchPermission = "core.organization.events.manage";
export const eventDeadLetterReadPermission = "core.organization.events.read";

export class EventDispatchError extends Error {
  constructor(
    readonly kind: EventFailureKind,
    readonly reasonCode: string,
    readonly retryable = isRetryableFailure(kind),
  ) {
    super(reasonCode);
    this.name = "EventDispatchError";
  }
}

export interface EventHandler {
  handlerName: string;
  eventType: EventType;
  eventVersion: number;
  owningModule: string;
  requiredModuleEntitlement: string | null;
  requiredPermissionKey: string | null;
  handle(
    transaction: OrganizationTransaction,
    event: EventEnvelope,
    context: ResolvedAuthorizationContext,
  ): Promise<void>;
}

export interface EventDispatchOptions {
  batchSize?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: Date;
}

export interface EventDispatchResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
  skipped: number;
}

export interface EventDeadLetterSummary {
  id: string;
  eventId: string;
  eventType: string;
  organizationId: string;
  handlerName: string;
  failureKind: EventFailureKind;
  failureReason: string;
  attempts: number;
  deadLetteredAt: Date;
  replayedAt: Date | null;
  replayCount: number;
}

interface EventAuditDescriptor {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | null;
}

const retryableKinds = new Set<EventFailureKind>([
  "TRANSIENT_INFRASTRUCTURE",
  "TEMPORARY_DATABASE",
  "HANDLER_FAILURE",
]);

export function isRetryableFailure(kind: EventFailureKind): boolean {
  return retryableKinds.has(kind);
}

export function calculateEventRetryDelay(
  attempt: number,
  baseDelayMs = 1_000,
  maxDelayMs = 3_600_000,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("Retry attempt must be a positive integer");
  }
  if (
    !Number.isFinite(baseDelayMs) ||
    baseDelayMs < 1 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < baseDelayMs
  ) {
    throw new RangeError("Invalid exponential backoff configuration");
  }
  return Math.min(baseDelayMs * 2 ** Math.min(attempt - 1, 30), maxDelayMs);
}

function validateOptions(options: EventDispatchOptions) {
  const batchSize = options.batchSize ?? 25;
  const maxAttempts = options.maxAttempts ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 3_600_000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError("Dispatch batch size must be between 1 and 100");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new RangeError("Maximum event attempts must be between 1 and 20");
  }
  calculateEventRetryDelay(1, baseDelayMs, maxDelayMs);
  return { batchSize, maxAttempts, baseDelayMs, maxDelayMs };
}

function safeFailureReason(error: unknown, fallback: EventFailureKind): {
  kind: EventFailureKind;
  reason: string;
  retryable: boolean;
} {
  if (error instanceof EventDispatchError) {
    return {
      kind: error.kind,
      reason: error.reasonCode,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error && error.name === "PostgresError") {
    return {
      kind: "TEMPORARY_DATABASE",
      reason: "DATABASE_OPERATION_FAILED",
      retryable: true,
    };
  }
  return {
    kind: fallback,
    reason: fallback,
    retryable: isRetryableFailure(fallback),
  };
}

function eventEnvelopeFromRow(row: typeof outboxEvents.$inferSelect): EventEnvelope {
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

async function writeEventAudit(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  action: string,
  event: EventAuditDescriptor,
  details: Record<string, unknown> = {},
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action,
    resource: "outbox_event",
    resourceId: event.eventId,
    result: "SUCCESS",
    requestMetadata: {
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      causationId: event.causationId,
      branchId: context.branchId,
      ...details,
    },
  });
}

async function writeInvalidEventDeadLetter(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  row: typeof outboxEvents.$inferSelect,
  now: Date,
): Promise<void> {
  const attempts = row.attempts + 1;
  const reason = "EVENT_CONTRACT_VALIDATION_FAILED";
  const [processing] = await transaction
    .select({ id: eventProcessingRecords.id })
    .from(eventProcessingRecords)
    .where(
      and(
        eq(eventProcessingRecords.organizationId, context.organizationId),
        eq(eventProcessingRecords.eventId, row.id),
        eq(eventProcessingRecords.handlerName, "platform.event-contract"),
      ),
    )
    .limit(1);
  if (processing) {
    await transaction
      .update(eventProcessingRecords)
      .set({
        status: "DEAD_LETTERED",
        attempts,
        failureKind: "INVALID_EVENT",
        lastError: reason,
        updatedAt: now,
      })
      .where(eq(eventProcessingRecords.id, processing.id));
  } else {
    await transaction.insert(eventProcessingRecords).values({
      organizationId: context.organizationId,
      eventId: row.id,
      eventType: row.eventType,
      handlerName: "platform.event-contract",
      eventVersion: row.version,
      status: "DEAD_LETTERED",
      attempts,
      failureKind: "INVALID_EVENT",
      lastError: reason,
    });
  }
  await transaction
    .insert(eventDeadLetters)
    .values({
      organizationId: context.organizationId,
      eventId: row.id,
      eventType: row.eventType,
      handlerName: "platform.event-contract",
      failureKind: "INVALID_EVENT",
      failureReason: reason,
      attempts,
      deadLetteredAt: now,
    })
    .onConflictDoUpdate({
      target: [eventDeadLetters.eventId, eventDeadLetters.handlerName],
      set: {
        failureKind: "INVALID_EVENT",
        failureReason: reason,
        attempts,
        deadLetteredAt: now,
        replayedAt: null,
        updatedAt: now,
      },
    });
  await transaction
    .update(outboxEvents)
    .set({
      status: "FAILED",
      deliveryStatus: "DEAD_LETTERED",
      attempts,
      lastError: reason,
      processingStartedAt: null,
      updatedAt: now,
    })
    .where(eq(outboxEvents.id, row.id));
  await writeEventAudit(transaction, context, "EVENT_DEAD_LETTERED", {
    eventId: row.id,
    eventType: row.eventType,
    eventVersion: row.version,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    correlationId: row.correlationId,
    causationId: row.causationId,
  }, { handlerName: "platform.event-contract", failureKind: "INVALID_EVENT", reason });
}

async function processHandler(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  event: EventEnvelope,
  handler: EventHandler,
  moduleAccess: Map<string, { allowed: boolean; reason?: string }>,
  now: Date,
  options: ReturnType<typeof validateOptions>,
): Promise<"SUCCEEDED" | "FAILED" | "DEAD_LETTERED" | "SKIPPED"> {
  const [existing] = await transaction
    .select()
    .from(eventProcessingRecords)
    .where(
      and(
        eq(eventProcessingRecords.organizationId, context.organizationId),
        eq(eventProcessingRecords.eventId, event.eventId),
        eq(eventProcessingRecords.handlerName, handler.handlerName),
      ),
    )
    .for("update")
    .limit(1);
  if (existing?.status === "SUCCEEDED") return "SKIPPED";
  if (existing?.status === "DEAD_LETTERED") return "DEAD_LETTERED";
  if (
    existing?.status === "FAILED" &&
    existing.nextAttemptAt !== null &&
    existing.nextAttemptAt > now
  ) {
    return "FAILED";
  }

  const attempts = (existing?.attempts ?? 0) + 1;
  if (existing) {
    await transaction
      .update(eventProcessingRecords)
      .set({
        status: "PROCESSING",
        attempts,
        nextAttemptAt: null,
        failureKind: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(eventProcessingRecords.id, existing.id));
  } else {
    await transaction.insert(eventProcessingRecords).values({
      organizationId: context.organizationId,
      eventId: event.eventId,
      eventType: event.eventType,
      handlerName: handler.handlerName,
      eventVersion: event.eventVersion,
      status: "PROCESSING",
      attempts,
    });
  }

  let failure: ReturnType<typeof safeFailureReason> | undefined;
  if (
    handler.requiredModuleEntitlement !== null &&
    moduleAccess.get(handler.requiredModuleEntitlement)?.allowed !== true
  ) {
    failure = {
      kind: "MODULE_UNAVAILABLE",
      reason: "REQUIRED_MODULE_NOT_ENTITLED",
      retryable: false,
    };
  } else if (
    handler.requiredPermissionKey !== null &&
    !context.permissions.some((grant) => grant.key === handler.requiredPermissionKey)
  ) {
    failure = {
      kind: "AUTHORIZATION_FAILURE",
      reason: "HANDLER_PERMISSION_REQUIRED",
      retryable: false,
    };
  } else {
    try {
      await transaction.transaction(async (handlerTransaction) =>
        handler.handle(
          handlerTransaction as unknown as OrganizationTransaction,
          event,
          context,
        ),
      );
    } catch (error) {
      failure = safeFailureReason(error, "HANDLER_FAILURE");
    }
  }

  if (!failure) {
    await transaction
      .update(eventProcessingRecords)
      .set({
        status: "SUCCEEDED",
        processedAt: now,
        failureKind: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(eventProcessingRecords.organizationId, context.organizationId),
          eq(eventProcessingRecords.eventId, event.eventId),
          eq(eventProcessingRecords.handlerName, handler.handlerName),
        ),
      );
    await writeEventAudit(transaction, context, "EVENT_HANDLER_SUCCEEDED", event, {
      handlerName: handler.handlerName,
      owningModule: handler.owningModule,
    });
    return "SUCCEEDED";
  }

  const deadLettered = !failure.retryable || attempts >= options.maxAttempts;
  const nextAttemptAt = deadLettered
    ? null
    : new Date(
        now.getTime() +
          calculateEventRetryDelay(
            attempts,
            options.baseDelayMs,
            options.maxDelayMs,
          ),
      );
  const processingStatus: EventProcessingStatus = deadLettered
    ? "DEAD_LETTERED"
    : "FAILED";
  await transaction
    .update(eventProcessingRecords)
    .set({
      status: processingStatus,
      nextAttemptAt,
      failureKind: failure.kind,
      lastError: failure.reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(eventProcessingRecords.organizationId, context.organizationId),
        eq(eventProcessingRecords.eventId, event.eventId),
        eq(eventProcessingRecords.handlerName, handler.handlerName),
      ),
    );

  if (deadLettered) {
    await transaction
      .insert(eventDeadLetters)
      .values({
        organizationId: context.organizationId,
        eventId: event.eventId,
        eventType: event.eventType,
        handlerName: handler.handlerName,
        failureKind: failure.kind,
        failureReason: failure.reason,
        attempts,
        deadLetteredAt: now,
      })
      .onConflictDoUpdate({
        target: [eventDeadLetters.eventId, eventDeadLetters.handlerName],
        set: {
          failureKind: failure.kind,
          failureReason: failure.reason,
          attempts,
          deadLetteredAt: now,
          replayedAt: null,
          updatedAt: now,
        },
      });
    await writeEventAudit(transaction, context, "EVENT_DEAD_LETTERED", event, {
      handlerName: handler.handlerName,
      owningModule: handler.owningModule,
      failureKind: failure.kind,
      failureReason: failure.reason,
      attempts,
    });
    return "DEAD_LETTERED";
  }

  await writeEventAudit(transaction, context, "EVENT_RETRY_SCHEDULED", event, {
    handlerName: handler.handlerName,
    owningModule: handler.owningModule,
    failureKind: failure.kind,
    failureReason: failure.reason,
    attempts,
    nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
  });
  return "FAILED";
}

async function auditHandledEvent(
  transaction: OrganizationTransaction,
  event: EventEnvelope,
  context: ResolvedAuthorizationContext,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: event.actorUserId ?? null,
    action: "EVENT_HANDLED",
    resource: event.aggregateType,
    resourceId: event.aggregateId,
    result: "SUCCESS",
    requestMetadata: {
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      correlationId: event.correlationId,
      causationId: event.causationId,
    },
  });
}

export const platformAuditEventHandlers: readonly EventHandler[] = (
  Object.keys(eventRegistry) as EventType[]
).map((eventType) => ({
  handlerName: `platform.audit.${eventType.toLowerCase()}`,
  eventType,
  eventVersion: eventRegistry[eventType].version,
  owningModule: "core.audit",
  requiredModuleEntitlement: null,
  requiredPermissionKey: null,
  handle: auditHandledEvent,
}));

function validateHandlers(handlers: readonly EventHandler[]): void {
  const registered = new Set<string>();
  for (const handler of handlers) {
    if (!/^[a-z][a-z0-9_.-]{1,149}$/.test(handler.handlerName)) {
      throw new TypeError("Invalid event handler name");
    }
    const definition = eventRegistry[handler.eventType];
    if (!definition || definition.version !== handler.eventVersion) {
      throw new TypeError("Handler declares an unsupported event type/version");
    }
    const key = `${handler.eventType}:${handler.eventVersion}:${handler.handlerName}`;
    if (registered.has(key)) throw new TypeError("Duplicate event handler registration");
    registered.add(key);
  }
}

export async function dispatchOutboxBatch(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  additionalHandlers: readonly EventHandler[] = [],
  dispatchOptions: EventDispatchOptions = {},
): Promise<EventDispatchResult> {
  const options = validateOptions(dispatchOptions);
  const handlers = [...platformAuditEventHandlers, ...additionalHandlers];
  validateHandlers(handlers);
  const now = dispatchOptions.now ?? new Date();
  const branchPredicate = context.branch
    ? or(
        isNull(outboxEvents.branchId),
        eq(outboxEvents.branchId, context.branch.branchId),
      )
    : isNull(outboxEvents.branchId);
  const pending = await transaction
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.organizationId, context.organizationId),
        inArray(outboxEvents.deliveryStatus, ["PENDING", "FAILED"]),
        lte(outboxEvents.nextAttemptAt, now),
        branchPredicate,
      ),
    )
    .orderBy(asc(outboxEvents.nextAttemptAt), asc(outboxEvents.createdAt))
    .limit(options.batchSize)
    .for("update", { skipLocked: true });

  const result: EventDispatchResult = {
    claimed: pending.length,
    published: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
  };
  const moduleAccess = new Map<string, { allowed: boolean; reason?: string }>();
  for (const handler of handlers) {
    if (
      handler.requiredModuleEntitlement &&
      !moduleAccess.has(handler.requiredModuleEntitlement)
    ) {
      const access = await loadOrganizationModuleAccess(
        transaction,
        context.organizationId,
      );
      moduleAccess.clear();
      for (const [moduleName, value] of access) {
        moduleAccess.set(moduleName, value);
      }
    }
  }

  for (const row of pending) {
    const eventAttempts = row.attempts + 1;
    await transaction
      .update(outboxEvents)
      .set({
        deliveryStatus: "PROCESSING",
        processingStartedAt: now,
        attempts: eventAttempts,
        updatedAt: now,
      })
      .where(eq(outboxEvents.id, row.id));

    let event: EventEnvelope;
    try {
      event = eventEnvelopeFromRow(row);
      if (
        event.organizationId !== context.organizationId ||
        (event.branchId !== undefined &&
          event.branchId !== context.branch?.branchId)
      ) {
        throw new EventDispatchError(
          "AUTHORIZATION_FAILURE",
          "EVENT_TENANT_OR_BRANCH_MISMATCH",
          false,
        );
      }
    } catch (error) {
      await writeInvalidEventDeadLetter(transaction, context, row, now);
      result.deadLettered += 1;
      continue;
    }

    const matchingHandlers = handlers.filter(
      (handler) =>
        handler.eventType === event.eventType &&
        handler.eventVersion === event.eventVersion,
    );
    if (matchingHandlers.length === 0) {
      await writeInvalidEventDeadLetter(transaction, context, row, now);
      result.deadLettered += 1;
      continue;
    }

    let hadFailure = false;
    let hadDeadLetter = false;
    let earliestRetry: Date | null = null;
    let lastFailureReason: string | null = null;
    for (const handler of matchingHandlers) {
      const outcome = await processHandler(
        transaction,
        context,
        event,
        handler,
        moduleAccess,
        now,
        options,
      );
      if (outcome === "SKIPPED") result.skipped += 1;
      if (outcome === "FAILED") {
        hadFailure = true;
        const [record] = await transaction
          .select({ nextAttemptAt: eventProcessingRecords.nextAttemptAt, lastError: eventProcessingRecords.lastError })
          .from(eventProcessingRecords)
          .where(
            and(
              eq(eventProcessingRecords.organizationId, context.organizationId),
              eq(eventProcessingRecords.eventId, event.eventId),
              eq(eventProcessingRecords.handlerName, handler.handlerName),
            ),
          )
          .limit(1);
        if (
          record?.nextAttemptAt &&
          (!earliestRetry || record.nextAttemptAt < earliestRetry)
        ) {
          earliestRetry = record.nextAttemptAt;
        }
        lastFailureReason = record?.lastError ?? "HANDLER_FAILURE";
      }
      if (outcome === "DEAD_LETTERED") {
        hadFailure = true;
        hadDeadLetter = true;
        lastFailureReason = "EVENT_HANDLER_DEAD_LETTERED";
      }
    }

    if (hadDeadLetter) {
      await transaction
        .update(outboxEvents)
        .set({
          status: "FAILED",
          deliveryStatus: "DEAD_LETTERED",
          lastError: lastFailureReason,
          processingStartedAt: null,
          updatedAt: now,
        })
        .where(eq(outboxEvents.id, event.eventId));
      result.deadLettered += 1;
    } else if (hadFailure) {
      await transaction
        .update(outboxEvents)
        .set({
          status: "FAILED",
          deliveryStatus: "FAILED",
          nextAttemptAt: earliestRetry ?? now,
          lastError: lastFailureReason,
          processingStartedAt: null,
          updatedAt: now,
        })
        .where(eq(outboxEvents.id, event.eventId));
      result.failed += 1;
    } else {
      await transaction
        .update(outboxEvents)
        .set({
          status: "PUBLISHED",
          deliveryStatus: "PUBLISHED",
          publishedAt: now,
          lastError: null,
          processingStartedAt: null,
          updatedAt: now,
        })
        .where(eq(outboxEvents.id, event.eventId));
      result.published += 1;
    }
  }
  return result;
}

export async function dispatchAuthorizedOutboxBatch(
  authorization: AuthorizationService,
  context: AuthorizationContext | null,
  metadata: AuthorizationMetadata,
  handlers: readonly EventHandler[] = [],
  options: EventDispatchOptions = {},
): Promise<AuthorizationResult<EventDispatchResult>> {
  return authorization.withPermission(
    context,
    eventDispatchPermission,
    metadata,
    (transaction, resolvedContext) =>
      dispatchOutboxBatch(transaction, resolvedContext, handlers, options),
  );
}

export async function listEventDeadLetters(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  limit = 50,
): Promise<EventDeadLetterSummary[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Dead-letter page size must be between 1 and 100");
  }
  return transaction
    .select({
      id: eventDeadLetters.id,
      eventId: eventDeadLetters.eventId,
      eventType: eventDeadLetters.eventType,
      organizationId: eventDeadLetters.organizationId,
      handlerName: eventDeadLetters.handlerName,
      failureKind: eventDeadLetters.failureKind,
      failureReason: eventDeadLetters.failureReason,
      attempts: eventDeadLetters.attempts,
      deadLetteredAt: eventDeadLetters.deadLetteredAt,
      replayedAt: eventDeadLetters.replayedAt,
      replayCount: eventDeadLetters.replayCount,
    })
    .from(eventDeadLetters)
    .where(eq(eventDeadLetters.organizationId, context.organizationId))
    .orderBy(asc(eventDeadLetters.replayedAt), asc(eventDeadLetters.deadLetteredAt))
    .limit(limit);
}

export async function listAuthorizedEventDeadLetters(
  authorization: AuthorizationService,
  context: AuthorizationContext | null,
  metadata: AuthorizationMetadata,
  limit = 50,
): Promise<AuthorizationResult<EventDeadLetterSummary[]>> {
  return authorization.withPermission(
    context,
    eventDeadLetterReadPermission,
    metadata,
    (transaction, resolvedContext) =>
      listEventDeadLetters(transaction, resolvedContext, limit),
  );
}

export async function replayEventDeadLetter(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  metadata: AuthorizationMetadata,
  eventId: string,
  handlerName: string,
): Promise<boolean> {
  const parsedEventId = z.uuid().parse(eventId);
  if (!/^[a-z][a-z0-9_.-]{1,149}$/.test(handlerName)) {
    throw new TypeError("Invalid event handler name");
  }
  const [deadLetter] = await transaction
    .select()
    .from(eventDeadLetters)
    .where(
      and(
        eq(eventDeadLetters.organizationId, context.organizationId),
        eq(eventDeadLetters.eventId, parsedEventId),
        eq(eventDeadLetters.handlerName, handlerName),
        isNull(eventDeadLetters.replayedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!deadLetter) return false;
  const [event] = await transaction
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.organizationId, context.organizationId),
        eq(outboxEvents.id, parsedEventId),
      ),
    )
    .for("update")
    .limit(1);
  if (!event) return false;

  const now = new Date();
  const replayCount = deadLetter.replayCount + 1;
  await transaction
    .update(eventDeadLetters)
    .set({ replayedAt: now, replayCount, updatedAt: now })
    .where(eq(eventDeadLetters.id, deadLetter.id));
  const [processing] = await transaction
    .update(eventProcessingRecords)
    .set({
      status: "FAILED",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      failureKind: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(eventProcessingRecords.organizationId, context.organizationId),
        eq(eventProcessingRecords.eventId, parsedEventId),
        eq(eventProcessingRecords.handlerName, handlerName),
      ),
    )
    .returning({ id: eventProcessingRecords.id });
  if (!processing) {
    await transaction.insert(eventProcessingRecords).values({
      organizationId: context.organizationId,
      eventId: parsedEventId,
      eventType: deadLetter.eventType,
      handlerName,
      eventVersion: event.version,
      status: "FAILED",
      nextAttemptAt: now,
    });
  }
  await transaction
    .update(outboxEvents)
    .set({
      status: "PENDING",
      deliveryStatus: "PENDING",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      processingStartedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(outboxEvents.organizationId, context.organizationId),
        eq(outboxEvents.id, parsedEventId),
      ),
    );
  await writeEventAudit(
    transaction,
    context,
    "EVENT_REPLAY_REQUESTED",
    {
      eventId: event.id,
      eventType: event.eventType,
      eventVersion: event.version,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      causationId: event.causationId,
    },
    { handlerName, replayCount },
  );
  return true;
}

export async function replayAuthorizedEventDeadLetter(
  authorization: AuthorizationService,
  context: AuthorizationContext | null,
  metadata: AuthorizationMetadata,
  eventId: string,
  handlerName: string,
): Promise<AuthorizationResult<boolean>> {
  return authorization.withPermission(
    context,
    eventDispatchPermission,
    metadata,
    (transaction, resolvedContext) =>
      replayEventDeadLetter(
        transaction,
        resolvedContext,
        metadata,
        eventId,
        handlerName,
      ),
  );
}
