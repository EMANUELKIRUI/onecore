import { z } from "zod";

const deploymentTypeSchema = z.enum([
  "SAAS",
  "CUSTOM",
  "DEDICATED",
  "ENTERPRISE",
]);
const organizationStatusSchema = z.enum([
  "PENDING",
  "UNDER_REVIEW",
  "APPROVED",
  "PAYMENT_PENDING",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "REJECTED",
  "CANCELLED",
]);
const entitlementSourceSchema = z.enum(["SUBSCRIPTION", "MANUAL", "CUSTOM"]);
const featureFlagScopeSchema = z.enum([
  "SYSTEM",
  "PLATFORM",
  "GLOBAL",
  "ENVIRONMENT",
  "MODULE",
  "ORGANIZATION",
  "BRANCH",
  "USER",
]);
const featureFlagTypeSchema = z.enum(["BOOLEAN", "STRING", "NUMBER", "JSON"]);

export const EVENT_ENVELOPE_MAX_LENGTH = 65_536;

const eventDefinitions = {
  ORGANIZATION_CREATED: {
    version: 1,
    owningModule: "core.organization",
    description: "An organization was provisioned on the platform.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        name: z.string().trim().min(1).max(200),
        slug: z.string().trim().min(1).max(100),
        deploymentType: deploymentTypeSchema,
      })
      .strict(),
  },
  ORGANIZATION_ACTIVATED: {
    version: 1,
    owningModule: "core.organization",
    description: "An organization entered the active lifecycle state.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        previousStatus: organizationStatusSchema,
        status: z.literal("ACTIVE"),
      })
      .strict(),
  },
  USER_CREATED: {
    version: 1,
    owningModule: "core.identity",
    description: "A platform identity was created.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        userId: z.uuid(),
        email: z.email().max(320),
        displayName: z.string().trim().min(1).max(200),
      })
      .strict(),
  },
  USER_INVITED: {
    version: 1,
    owningModule: "core.organization",
    description: "A user was invited to an organization.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        userId: z.uuid(),
        membershipId: z.uuid(),
        email: z.email().max(320),
      })
      .strict(),
  },
  USER_ROLE_CHANGED: {
    version: 1,
    owningModule: "core.rbac",
    description: "A membership role assignment changed.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        userId: z.uuid(),
        membershipId: z.uuid(),
        roleId: z.uuid(),
        change: z.enum(["ASSIGNED", "REMOVED"]),
      })
      .strict(),
  },
  MODULE_ENABLED: {
    version: 1,
    owningModule: "core.modules",
    description: "An organization module entitlement was enabled.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        moduleKey: z.string().trim().min(1).max(100),
        source: entitlementSourceSchema,
      })
      .strict(),
  },
  MODULE_DISABLED: {
    version: 1,
    owningModule: "core.modules",
    description: "An organization module entitlement was disabled.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        moduleKey: z.string().trim().min(1).max(100),
        source: entitlementSourceSchema,
      })
      .strict(),
  },
  FEATURE_FLAG_CHANGED: {
    version: 1,
    owningModule: "core.organization",
    description: "A tenant feature assignment changed.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        flagKey: z.string().trim().min(1).max(120),
        valueType: featureFlagTypeSchema,
        scope: featureFlagScopeSchema,
      })
      .strict(),
  },
  CONFIGURATION_CHANGED: {
    version: 1,
    owningModule: "core.organization",
    description: "Organization configuration metadata changed.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        resource: z.string().trim().min(1).max(100),
        resourceId: z.uuid(),
        changedFields: z.array(z.string().trim().min(1).max(100)).max(100),
      })
      .strict(),
  },
  JOB_ENQUEUED: {
    version: 1,
    owningModule: "core.jobs",
    description: "A tenant-scoped platform job was queued.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        jobId: z.uuid(),
        jobType: z.string().trim().min(1).max(100),
      })
      .strict(),
  },
  JOB_COMPLETED: {
    version: 1,
    owningModule: "core.jobs",
    description: "A tenant-scoped platform job completed.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        jobId: z.uuid(),
        jobType: z.string().trim().min(1).max(100),
      })
      .strict(),
  },
  JOB_FAILED: {
    version: 1,
    owningModule: "core.jobs",
    description: "A tenant-scoped platform job exhausted its attempts.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        jobId: z.uuid(),
        jobType: z.string().trim().min(1).max(100),
        failureKind: z.enum(["PERMANENT", "RETRIES_EXHAUSTED"]),
      })
      .strict(),
  },
  NOTIFICATION_CREATED: {
    version: 1,
    owningModule: "core.organization",
    description: "An in-app notification was created for an organization user.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        notificationId: z.uuid(),
        recipientUserId: z.uuid(),
        notificationType: z.string().trim().min(1).max(100),
      })
      .strict(),
  },
  COMMUNICATION_QUEUED: {
    version: 1,
    owningModule: "core.organization",
    description: "A tenant-scoped communication intent was queued.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        messageId: z.uuid(),
        deliveryId: z.uuid(),
        channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
        category: z.string().trim().min(1).max(100),
      })
      .strict(),
  },
  STORAGE_OBJECT_CREATED: {
    version: 1,
    owningModule: "core.organization",
    description: "A tenant-owned object was stored.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        objectId: z.uuid(),
        byteSize: z.number().int().nonnegative(),
        provider: z.enum(["LOCAL"]),
      })
      .strict(),
  },
  STORAGE_OBJECT_DELETED: {
    version: 1,
    owningModule: "core.organization",
    description: "A tenant-owned object was marked deleted.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z.object({ objectId: z.uuid() }).strict(),
  },
  SEARCH_DOCUMENT_INDEXED: {
    version: 1,
    owningModule: "core.organization",
    description: "A tenant-owned document was indexed for search.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        indexName: z.string().trim().min(1).max(100),
        documentId: z.string().trim().min(1).max(200),
      })
      .strict(),
  },
  SEARCH_DOCUMENT_DELETED: {
    version: 1,
    owningModule: "core.organization",
    description: "A tenant-owned search document was removed.",
    compatibilityPolicy: "ADDITIVE_ONLY",
    payloadSchema: z
      .object({
        indexName: z.string().trim().min(1).max(100),
        documentId: z.string().trim().min(1).max(200),
      })
      .strict(),
  },
} as const;

export const eventRegistry = eventDefinitions;
export type EventType = keyof typeof eventRegistry;
export type EventPayload<TEventType extends EventType> = z.infer<
  (typeof eventRegistry)[TEventType]["payloadSchema"]
>;

export const eventTypeSchema = z.enum(
  Object.keys(eventRegistry) as [EventType, ...EventType[]],
);
export const eventFailureKinds = [
  "TRANSIENT_INFRASTRUCTURE",
  "TEMPORARY_DATABASE",
  "HANDLER_FAILURE",
  "INVALID_EVENT",
  "AUTHORIZATION_FAILURE",
  "BUSINESS_VALIDATION",
  "MODULE_UNAVAILABLE",
] as const;
export const eventFailureKindSchema = z.enum(eventFailureKinds);
export type EventFailureKind = z.infer<typeof eventFailureKindSchema>;

export const eventDeliveryStatuses = [
  "PENDING",
  "PROCESSING",
  "PUBLISHED",
  "FAILED",
  "DEAD_LETTERED",
] as const;
export const eventDeliveryStatusSchema = z.enum(eventDeliveryStatuses);
export type EventDeliveryStatus = z.infer<typeof eventDeliveryStatusSchema>;

export const eventProcessingStatuses = [
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "DEAD_LETTERED",
] as const;
export const eventProcessingStatusSchema = z.enum(eventProcessingStatuses);
export type EventProcessingStatus = z.infer<typeof eventProcessingStatusSchema>;

export const eventEnvelopeSchema = z
  .object({
    eventId: z.uuid(),
    eventType: eventTypeSchema,
    eventVersion: z.number().int().positive(),
    occurredAt: z.date(),
    organizationId: z.uuid(),
    branchId: z.uuid().optional(),
    actorUserId: z.uuid().optional(),
    correlationId: z.uuid(),
    causationId: z.uuid().optional(),
    aggregateType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    aggregateId: z.uuid(),
    payload: z.json(),
    metadata: z.record(z.string(), z.json()),
  })
  .strict();

export type EventEnvelope<TEventType extends EventType = EventType> =
  TEventType extends EventType
    ? {
        eventId: string;
        eventType: TEventType;
        eventVersion: number;
        occurredAt: Date;
        organizationId: string;
        branchId?: string;
        actorUserId?: string;
        correlationId: string;
        causationId?: string;
        aggregateType: string;
        aggregateId: string;
        payload: EventPayload<TEventType>;
        metadata: Record<string, unknown>;
      }
    : never;

export type CreateEventInput<TEventType extends EventType> = {
  eventType: TEventType;
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  payload: EventPayload<TEventType>;
  branchId?: string;
  actorUserId?: string;
  causationId?: string;
  correlationId?: string;
  eventId?: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
};

const forbiddenMetadataKey = /^(code|script|sql|shell|command|exec|evaluate)$/i;
const sensitiveMetadataKey =
  /(password|passwd|token|secret|credential|apikey|privatekey)/i;

function metadataIsInert(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) {
    return value.every((child) => metadataIsInert(child, depth + 1));
  }
  if (typeof value !== "object" || value === null) return true;
  return Object.entries(value).every(([key, child]) => {
    const normalizedKey = key.replace(/[^a-z]/gi, "");
    return (
      !forbiddenMetadataKey.test(key) &&
      !sensitiveMetadataKey.test(normalizedKey) &&
      metadataIsInert(child, depth + 1)
    );
  });
}

export function createDomainEvent<TEventType extends EventType>(
  input: CreateEventInput<TEventType>,
): EventEnvelope<TEventType> {
  const definition = eventRegistry[input.eventType];
  const envelope = {
    eventId: input.eventId ?? crypto.randomUUID(),
    eventType: input.eventType,
    eventVersion: definition.version,
    occurredAt: input.occurredAt ?? new Date(),
    organizationId: input.organizationId,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    correlationId: input.correlationId ?? crypto.randomUUID(),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
    metadata: input.metadata ?? {},
  };
  return parseDomainEvent(envelope) as EventEnvelope<TEventType>;
}

export function parseDomainEvent(value: unknown): EventEnvelope {
  const envelope = eventEnvelopeSchema.parse(value);
  const definition = eventRegistry[envelope.eventType];
  if (envelope.eventVersion !== definition.version) {
    throw new TypeError(
      `Unsupported ${envelope.eventType} event version: ${envelope.eventVersion}`,
    );
  }
  definition.payloadSchema.parse(envelope.payload);
  if (!metadataIsInert(envelope.metadata)) {
    throw new TypeError("Event metadata must be inert JSON data");
  }
  if (JSON.stringify(envelope).length > EVENT_ENVELOPE_MAX_LENGTH) {
    throw new RangeError("Event envelope exceeds the maximum size");
  }
  return envelope as EventEnvelope;
}
