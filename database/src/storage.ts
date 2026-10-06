import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, normalize, parse } from "node:path";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  createDomainEvent,
  storageFilenameSchema,
  storageMimeTypeSchema,
  type StoredObjectProvider,
} from "@onecore/core-domain";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  ResolvedAuthorizationContext,
} from "./authorization.js";
import { writeAuthorizationMutationEvent } from "./authorization.js";
import { storedObjects } from "../schema/index.js";
import { recordOutboxEvent } from "./outbox.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import type { Database } from "./index.js";
import { observeServiceOperation } from "./service-telemetry.js";

export interface StoredObjectRecord {
  id: string;
  organizationId: string;
  branchId: string | null;
  createdByUserId: string | null;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  provider: StoredObjectProvider;
  status: "ACTIVE" | "DELETED";
  createdAt: Date;
  updatedAt: Date;
}

export interface StorageUploadInput {
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  content: Buffer;
  branchId?: string;
}

export interface PlatformStorageObject {
  metadata: StoredObjectRecord;
  content: Buffer;
}

export interface StorageProvider {
  provider: StoredObjectProvider;
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export interface LocalStorageOptions {
  provider?: "LOCAL";
  rootDirectory: string;
}

export interface StorageService {
  upload(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    input: unknown,
  ): Promise<AuthorizationResult<{ id: string } | null>>;
  get(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    objectId: string,
  ): Promise<AuthorizationResult<PlatformStorageObject | null>>;
  list(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    pagination?: { limit?: number; offset?: number },
  ): Promise<AuthorizationResult<StoredObjectRecord[]>>;
  delete(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    objectId: string,
  ): Promise<AuthorizationResult<boolean>>;
}

const storageUploadInputSchema = z
  .object({
    originalFilename: storageFilenameSchema,
    mimeType: storageMimeTypeSchema,
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
    content: z.instanceof(Buffer),
    branchId: z.uuid().optional(),
  })
  .strict();

function normalizeObjectKey(value: string): string {
  const normalized = normalize(value).replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !segments.length ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("Invalid storage key");
  }
  return segments.join("/");
}

function storageKeyFor(
  organizationId: string,
  branchId: string | null,
  objectId: string,
  originalFilename: string,
): string {
  const extension = parse(originalFilename).ext || "";
  const safeFilename = `${objectId}${extension}`;
  return normalizeObjectKey(
    join(organizationId, branchId ?? "global", `${safeFilename}.bin`),
  );
}

function checksum(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function branchMatches(
  requestedBranchId: string | undefined,
  context: ResolvedAuthorizationContext,
): boolean {
  return (
    requestedBranchId === undefined || requestedBranchId === context.branchId
  );
}

async function ensureLocalKey(
  rootDirectory: string,
  objectKey: string,
): Promise<string> {
  const absoluteRoot = normalize(rootDirectory);
  const filePath = join(absoluteRoot, objectKey);
  const directory = parse(filePath).dir;
  await mkdir(directory, { recursive: true });
  return filePath;
}

export function createLocalStorageProvider(
  options: LocalStorageOptions,
): StorageProvider {
  if (!options.rootDirectory.trim()) {
    throw new TypeError("Storage root directory is required");
  }
  return {
    provider: "LOCAL",
    async put(key, content) {
      const filePath = await ensureLocalKey(options.rootDirectory, key);
      await writeFile(filePath, content, { flag: "wx" });
    },
    async get(key) {
      const filePath = await ensureLocalKey(options.rootDirectory, key);
      return readFile(filePath);
    },
    async delete(key) {
      const filePath = await ensureLocalKey(options.rootDirectory, key);
      await rm(filePath, { force: true });
      const parent = parse(filePath).dir;
      await rm(parent, { recursive: true, force: true });
    },
  };
}

export function createStorageService(
  database: Database,
  authorization: AuthorizationService,
  provider: LocalStorageOptions,
): StorageService {
  const storage = createLocalStorageProvider(provider);

  async function selectObject(
    transaction: OrganizationTransaction,
    objectId: string,
    organizationId: string,
    branchId: string | null,
  ): Promise<StoredObjectRecord | undefined> {
    const [row] = await transaction
      .select()
      .from(storedObjects)
      .where(
        and(
          eq(storedObjects.id, objectId),
          eq(storedObjects.organizationId, organizationId),
          branchId
            ? or(
                isNull(storedObjects.branchId),
                eq(storedObjects.branchId, branchId),
              )
            : isNull(storedObjects.branchId),
          eq(storedObjects.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return row;
  }

  return {
    async upload(context, metadata, input) {
      const parsed = storageUploadInputSchema.parse(input);
      return observeServiceOperation(
        "storage.upload",
        {
          operation: "put",
          provider: storage.provider,
          byteSize: parsed.byteSize,
          mimeType: parsed.mimeType,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.storage.manage",
            metadata,
            async (transaction, resolved) => {
              if (!branchMatches(parsed.branchId, resolved)) return null;
              if (parsed.content.length !== parsed.byteSize) {
                return null;
              }
              const objectId = randomUUID();
              const storageKey = storageKeyFor(
                resolved.organizationId,
                resolved.branchId,
                objectId,
                parsed.originalFilename,
              );
              const hash = checksum(parsed.content);
              try {
                await storage.put(storageKey, parsed.content);
              } catch (error) {
                throw new Error(
                  `Storage backend failed: ${error instanceof Error ? error.message : String(error)}`,
                  { cause: error },
                );
              }
              const [record] = await transaction
                .insert(storedObjects)
                .values({
                  id: objectId,
                  organizationId: resolved.organizationId,
                  branchId: resolved.branchId,
                  createdByUserId: resolved.userId,
                  originalFilename: parsed.originalFilename,
                  storageKey,
                  mimeType: parsed.mimeType,
                  byteSize: parsed.byteSize,
                  checksumSha256: hash,
                  provider: storage.provider,
                })
                .returning({ id: storedObjects.id });
              if (!record) {
                await storage.delete(storageKey).catch(() => undefined);
                throw new Error("Stored object metadata was not created");
              }
              await writeAuthorizationMutationEvent(
                transaction,
                resolved,
                metadata,
                "STORAGE_OBJECT_CREATED",
                "stored_object",
                record.id,
                { provider: storage.provider, byteSize: parsed.byteSize },
              );
              await recordOutboxEvent(
                transaction,
                createDomainEvent({
                  eventType: "STORAGE_OBJECT_CREATED",
                  organizationId: resolved.organizationId,
                  ...(resolved.branchId ? { branchId: resolved.branchId } : {}),
                  actorUserId: resolved.userId,
                  aggregateType: "stored_object",
                  aggregateId: record.id,
                  payload: {
                    objectId: record.id,
                    byteSize: parsed.byteSize,
                    provider: storage.provider,
                  },
                  metadata: { requestId: metadata.requestId },
                }),
              );
              return { id: record.id };
            },
          ),
        (result) => ({
          objectId: result.allowed ? (result.value?.id ?? null) : null,
        }),
      );
    },

    async get(context, metadata, objectId) {
      return observeServiceOperation(
        "storage.get",
        {
          operation: "get",
          objectId,
          provider: storage.provider,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.storage.read",
            metadata,
            async (transaction, resolved) => {
              const row = await selectObject(
                transaction,
                objectId,
                resolved.organizationId,
                resolved.branchId,
              );
              if (!row) return null;
              const content = await storage.get(row.storageKey);
              return { metadata: row, content };
            },
          ),
        (result) => ({
          byteSize:
            result.allowed && result.value
              ? result.value.metadata.byteSize
              : null,
        }),
      );
    },

    async list(context, metadata, pagination = {}) {
      const limit = Math.min(Math.max(pagination.limit ?? 20, 1), 100);
      const offset = Math.min(Math.max(pagination.offset ?? 0, 0), 10_000);
      return observeServiceOperation(
        "storage.list",
        {
          operation: "list",
          provider: storage.provider,
          limit,
          offset,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.storage.read",
            metadata,
            async (transaction, resolved) =>
              transaction
                .select()
                .from(storedObjects)
                .where(
                  and(
                    eq(storedObjects.organizationId, resolved.organizationId),
                    resolved.branchId
                      ? or(
                          isNull(storedObjects.branchId),
                          eq(storedObjects.branchId, resolved.branchId),
                        )
                      : isNull(storedObjects.branchId),
                    eq(storedObjects.status, "ACTIVE"),
                  ),
                )
                .orderBy(asc(storedObjects.createdAt), asc(storedObjects.id))
                .limit(limit)
                .offset(offset),
          ),
        (result) => ({
          objectCount: result.allowed ? (result.value?.length ?? 0) : 0,
        }),
      );
    },

    async delete(context, metadata, objectId) {
      return observeServiceOperation(
        "storage.delete",
        {
          operation: "delete",
          objectId,
          provider: storage.provider,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.storage.manage",
            metadata,
            async (transaction, resolved) => {
              const row = await selectObject(
                transaction,
                objectId,
                resolved.organizationId,
                resolved.branchId,
              );
              if (!row) return false;
              try {
                await storage.delete(row.storageKey);
              } catch (error) {
                throw new Error(
                  `Storage backend failed: ${error instanceof Error ? error.message : String(error)}`,
                  { cause: error },
                );
              }
              const [updated] = await transaction
                .update(storedObjects)
                .set({ status: "DELETED", updatedAt: new Date() })
                .where(eq(storedObjects.id, row.id))
                .returning({ id: storedObjects.id });
              if (!updated) return false;
              await writeAuthorizationMutationEvent(
                transaction,
                resolved,
                metadata,
                "STORAGE_OBJECT_DELETED",
                "stored_object",
                updated.id,
              );
              await recordOutboxEvent(
                transaction,
                createDomainEvent({
                  eventType: "STORAGE_OBJECT_DELETED",
                  organizationId: resolved.organizationId,
                  ...(resolved.branchId ? { branchId: resolved.branchId } : {}),
                  actorUserId: resolved.userId,
                  aggregateType: "stored_object",
                  aggregateId: updated.id,
                  payload: { objectId: updated.id },
                  metadata: { requestId: metadata.requestId },
                }),
              );
              return true;
            },
          ),
      );
    },
  };
}
