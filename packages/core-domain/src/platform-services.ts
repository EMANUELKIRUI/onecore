import { z } from "zod";
import { EVENT_ENVELOPE_MAX_LENGTH } from "./events.js";

export const jobStatuses = [
  "QUEUED",
  "RUNNING",
  "RETRY_WAIT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export const jobStatusSchema = z.enum(jobStatuses);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9_.-]+$/);

const sensitiveKeyPattern =
  /password|secret|token|api[_-]?key|credential|private[_-]?key|authorization/i;

function containsSensitiveKey(value: unknown, depth = 0): boolean {
  if (depth > 10) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveKey(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      sensitiveKeyPattern.test(key) || containsSensitiveKey(child, depth + 1),
  );
}

function boundedJsonObject(maxBytes: number) {
  return z
    .record(z.string(), z.json())
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes,
      `JSON data must not exceed ${maxBytes} bytes`,
    )
    .refine(
      (value) => !containsSensitiveKey(value),
      "Sensitive fields are not permitted",
    );
}

export const platformJobPayloadSchema = boundedJsonObject(
  EVENT_ENVELOPE_MAX_LENGTH,
);

export const enqueueJobSchema = z
  .object({
    jobType: jobNameSchema,
    payload: platformJobPayloadSchema,
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    branchId: z.uuid().optional(),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
    priority: z.number().int().min(0).max(100).default(0),
    maxAttempts: z.number().int().min(1).max(20).default(5),
  })
  .strict();
export type EnqueueJobInput = z.infer<typeof enqueueJobSchema>;

export const notificationChannels = [
  "IN_APP",
  "EMAIL",
  "SMS",
  "PUSH",
  "WEBHOOK",
] as const;
export const notificationChannelSchema = z.enum(notificationChannels);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationDeliveryStatuses = [
  "PENDING",
  "SENT",
  "DELIVERED",
  "FAILED",
  "NOT_APPLICABLE",
] as const;
export const notificationDeliveryStatusSchema = z.enum(
  notificationDeliveryStatuses,
);
export type NotificationDeliveryStatus = z.infer<
  typeof notificationDeliveryStatusSchema
>;

export const notificationInputSchema = z
  .object({
    recipientUserId: z.uuid(),
    notificationType: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(16_384),
    metadata: boundedJsonObject(16_384).default({}),
    branchId: z.uuid().optional(),
  })
  .strict();
export type NotificationInput = z.infer<typeof notificationInputSchema>;

export const storedObjectProviders = ["LOCAL"] as const;
export const storedObjectProviderSchema = z.enum(storedObjectProviders);
export type StoredObjectProvider = z.infer<typeof storedObjectProviderSchema>;

export const storedObjectStatuses = ["ACTIVE", "DELETED"] as const;
export const storedObjectStatusSchema = z.enum(storedObjectStatuses);
export type StoredObjectStatus = z.infer<typeof storedObjectStatusSchema>;

export const storageFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (filename) =>
      filename !== "." &&
      filename !== ".." &&
      !filename.includes("/") &&
      !filename.includes("\\") &&
      !Array.from(filename).some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }) &&
      !filename.startsWith("."),
  );

export const storageMimeTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);

export const storageUploadMetadataSchema = z
  .object({
    originalFilename: storageFilenameSchema,
    mimeType: storageMimeTypeSchema,
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
    branchId: z.uuid().optional(),
  })
  .strict();

export const searchIndexNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[a-z][a-z0-9_.-]+$/);

export const searchDocumentIdSchema = z.string().trim().min(1).max(200);

export const searchQuerySchema = z.string().trim().min(2).max(256);

export const searchRequestSchema = z
  .object({
    indexName: searchIndexNameSchema,
    query: searchQuerySchema,
    branchId: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const searchDocumentInputSchema = z
  .object({
    indexName: searchIndexNameSchema,
    documentId: searchDocumentIdSchema,
    title: z.string().trim().min(1).max(500),
    body: z.string().max(65_536),
    metadata: boundedJsonObject(16_384).default({}),
    branchId: z.uuid().optional(),
  })
  .strict();
