import { hashRateLimitIdentity } from "@onecore/config";
import {
  createDomainEvent,
  notificationInputSchema,
  resolveCommunicationPreference,
  searchDocumentInputSchema,
  searchRequestSchema,
  type EventPayload,
} from "@onecore/core-domain";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  ResolvedAuthorizationContext,
} from "./authorization.js";
import { writeAuthorizationMutationEvent } from "./authorization.js";
import {
  resourceScopeAllowsCreate,
  resourceScopePredicate,
} from "./resource-authorization.js";
import type { OrganizationTransaction } from "./index.js";
import {
  membershipBranches,
  notifications,
  notificationDeliveries,
  notificationPreferences,
  organizationMemberships,
  searchDocuments,
} from "../schema/index.js";
import { recordOutboxEvent } from "./outbox.js";
import { observeServiceOperation } from "./service-telemetry.js";

export interface SearchResult {
  documentId: string;
  indexName: string;
  title: string;
  excerpt: string;
  branchId: string | null;
  updatedAt: Date;
}

export interface PlatformServices {
  createNotification(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    input: unknown,
  ): Promise<AuthorizationResult<{ id: string } | null>>;
  listNotifications(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    pagination?: { limit?: number; offset?: number },
  ): Promise<AuthorizationResult<(typeof notifications.$inferSelect)[]>>;
  setNotificationReadState(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    notificationId: string,
    read: boolean,
  ): Promise<AuthorizationResult<boolean>>;
  indexSearchDocument(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    input: unknown,
  ): Promise<AuthorizationResult<boolean>>;
  removeSearchDocument(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    indexName: string,
    documentId: string,
  ): Promise<AuthorizationResult<boolean>>;
  search(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    input: unknown,
  ): Promise<AuthorizationResult<SearchResult[]>>;
}

function platformEvent<
  T extends
    | "NOTIFICATION_CREATED"
    | "SEARCH_DOCUMENT_INDEXED"
    | "SEARCH_DOCUMENT_DELETED",
>(
  context: ResolvedAuthorizationContext,
  eventType: T,
  aggregateType: string,
  aggregateId: string,
  payload: EventPayload<T>,
  requestId: string,
  correlationId: string,
) {
  return createDomainEvent({
    eventType,
    organizationId: context.organizationId,
    ...(context.branchId ? { branchId: context.branchId } : {}),
    actorUserId: context.userId,
    correlationId,
    aggregateType,
    aggregateId,
    payload,
    metadata: { requestId },
  });
}

function branchInputMatches(
  requestedBranchId: string | undefined,
  context: ResolvedAuthorizationContext,
): boolean {
  return (
    requestedBranchId === undefined || requestedBranchId === context.branchId
  );
}

async function validateRecipientBranch(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  recipientUserId: string,
): Promise<boolean> {
  const [membership] = await transaction
    .select({
      membershipId: organizationMemberships.id,
      branchAccessMode: organizationMemberships.branchAccessMode,
    })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, context.organizationId),
        eq(organizationMemberships.userId, recipientUserId),
        eq(organizationMemberships.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!membership) return false;
  if (!context.branchId || membership.branchAccessMode === "ALL") return true;
  const [assignment] = await transaction
    .select({ branchId: membershipBranches.branchId })
    .from(membershipBranches)
    .where(
      and(
        eq(membershipBranches.organizationId, context.organizationId),
        eq(membershipBranches.membershipId, membership.membershipId),
        eq(membershipBranches.branchId, context.branchId),
      ),
    )
    .limit(1);
  return assignment !== undefined;
}

export function createPlatformServices(
  authorization: AuthorizationService,
): PlatformServices {
  return {
    async createNotification(context, metadata, input) {
      const parsed = notificationInputSchema.parse(input);
      return observeServiceOperation(
        "notification.create",
        {
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          recipientHash: hashRateLimitIdentity(parsed.recipientUserId),
          notificationType: parsed.notificationType,
          channel: "IN_APP",
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.notification_inbox.manage",
            metadata,
            async (transaction, resolved) => {
              if (!branchInputMatches(parsed.branchId, resolved)) return null;
              const recipientAllowed = await validateRecipientBranch(
                transaction,
                resolved,
                parsed.recipientUserId,
              );
              if (!recipientAllowed) return null;

              const preferenceRows = await transaction
                .select({
                  userId: notificationPreferences.userId,
                  enabled: notificationPreferences.enabled,
                })
                .from(notificationPreferences)
                .where(
                  and(
                    eq(
                      notificationPreferences.organizationId,
                      resolved.organizationId,
                    ),
                    eq(notificationPreferences.channel, "IN_APP"),
                    eq(
                      notificationPreferences.category,
                      parsed.notificationType,
                    ),
                    or(
                      isNull(notificationPreferences.userId),
                      eq(
                        notificationPreferences.userId,
                        parsed.recipientUserId,
                      ),
                    ),
                  ),
                );
              const organizationDefault = preferenceRows.find(
                (preference) => preference.userId === null,
              )?.enabled;
              const userOverride = preferenceRows.find(
                (preference) => preference.userId === parsed.recipientUserId,
              )?.enabled;
              if (
                !resolveCommunicationPreference({
                  platformDefault: true,
                  ...(organizationDefault === undefined
                    ? {}
                    : { organizationDefault }),
                  ...(userOverride === undefined ? {} : { userOverride }),
                })
              ) {
                return null;
              }

              const [notification] = await transaction
                .insert(notifications)
                .values({
                  organizationId: resolved.organizationId,
                  branchId: resolved.branchId,
                  recipientUserId: parsed.recipientUserId,
                  createdByUserId: resolved.userId,
                  notificationType: parsed.notificationType,
                  title: parsed.title,
                  body: parsed.body,
                  metadata: parsed.metadata,
                })
                .returning({ id: notifications.id });
              if (!notification)
                throw new Error("Notification insert returned no row");

              await transaction.insert(notificationDeliveries).values({
                organizationId: resolved.organizationId,
                notificationId: notification.id,
                channel: "IN_APP",
                status: "DELIVERED",
                attempts: 1,
                deliveredAt: new Date(),
              });
              await writeAuthorizationMutationEvent(
                transaction,
                resolved,
                metadata,
                "NOTIFICATION_CREATED",
                "notification",
                notification.id,
                { recipientUserId: parsed.recipientUserId },
              );
              await recordOutboxEvent(
                transaction,
                platformEvent(
                  resolved,
                  "NOTIFICATION_CREATED",
                  "notification",
                  notification.id,
                  {
                    notificationId: notification.id,
                    recipientUserId: parsed.recipientUserId,
                    notificationType: parsed.notificationType,
                  },
                  metadata.requestId,
                  metadata.correlationId ?? metadata.requestId,
                ),
              );
              return { id: notification.id };
            },
          ),
        (result) => ({
          notificationId:
            result.allowed && result.value ? result.value.id : null,
        }),
      );
    },

    async listNotifications(context, metadata, pagination = {}) {
      const limit = Math.min(Math.max(pagination.limit ?? 20, 1), 100);
      const offset = Math.min(Math.max(pagination.offset ?? 0, 0), 10_000);
      return observeServiceOperation(
        "notification.list",
        {
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.notification_inbox.update_self",
            metadata,
            async (transaction, resolved) =>
              transaction
                .select()
                .from(notifications)
                .where(
                  and(
                    eq(notifications.organizationId, resolved.organizationId),
                    eq(notifications.recipientUserId, resolved.userId),
                    resolved.branchId
                      ? or(
                          isNull(notifications.branchId),
                          eq(notifications.branchId, resolved.branchId),
                        )
                      : isNull(notifications.branchId),
                  ),
                )
                .orderBy(desc(notifications.createdAt), desc(notifications.id))
                .limit(limit)
                .offset(offset),
          ),
        (result) => ({
          notificationCount:
            result.allowed && result.value ? result.value.length : 0,
        }),
      );
    },

    async setNotificationReadState(context, metadata, notificationId, read) {
      const id = cryptoUuid(notificationId);
      return observeServiceOperation(
        "notification.read_state",
        {
          notificationId,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.notification_inbox.read",
            metadata,
            async (transaction, resolved) => {
              const [updated] = await transaction
                .update(notifications)
                .set({ readAt: read ? new Date() : null })
                .where(
                  and(
                    eq(notifications.id, id),
                    eq(notifications.organizationId, resolved.organizationId),
                    eq(notifications.recipientUserId, resolved.userId),
                    resolved.branchId
                      ? or(
                          isNull(notifications.branchId),
                          eq(notifications.branchId, resolved.branchId),
                        )
                      : isNull(notifications.branchId),
                  ),
                )
                .returning({ id: notifications.id });
              return updated !== undefined;
            },
          ),
      );
    },

    async indexSearchDocument(context, metadata, input) {
      const parsed = searchDocumentInputSchema.parse(input);
      return observeServiceOperation(
        "search.index",
        {
          backend: "postgresql",
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.search.manage",
            metadata,
            async (transaction, resolved) => {
              if (!branchInputMatches(parsed.branchId, resolved)) return false;
              if (
                !resourceScopeAllowsCreate(
                  resolved,
                  "core.organization.search.manage",
                  {
                    organizationId: resolved.organizationId,
                    branchId: resolved.branchId,
                  },
                )
              ) {
                return false;
              }
              const rowScope = resourceScopePredicate(
                resolved,
                "core.organization.search.manage",
                {
                  organizationId: searchDocuments.organizationId,
                  branchId: searchDocuments.branchId,
                },
              );
              if (!rowScope) return false;
              const [document] = await transaction
                .insert(searchDocuments)
                .values({
                  organizationId: resolved.organizationId,
                  branchId: resolved.branchId,
                  indexName: parsed.indexName,
                  documentId: parsed.documentId,
                  title: parsed.title,
                  body: parsed.body,
                  metadata: parsed.metadata,
                })
                .onConflictDoUpdate({
                  target: [
                    searchDocuments.organizationId,
                    searchDocuments.indexName,
                    searchDocuments.documentId,
                  ],
                  set: {
                    branchId: resolved.branchId,
                    title: parsed.title,
                    body: parsed.body,
                    metadata: parsed.metadata,
                    updatedAt: new Date(),
                  },
                  setWhere: rowScope,
                })
                .returning({ id: searchDocuments.id });
              if (!document) return false;

              await writeAuthorizationMutationEvent(
                transaction,
                resolved,
                metadata,
                "SEARCH_DOCUMENT_INDEXED",
                "search_document",
                document.id,
                { indexName: parsed.indexName, documentId: parsed.documentId },
              );
              await recordOutboxEvent(
                transaction,
                platformEvent(
                  resolved,
                  "SEARCH_DOCUMENT_INDEXED",
                  "search_document",
                  document.id,
                  {
                    indexName: parsed.indexName,
                    documentId: parsed.documentId,
                  },
                  metadata.requestId,
                  metadata.correlationId ?? metadata.requestId,
                ),
              );
              return true;
            },
          ),
      );
    },

    async removeSearchDocument(context, metadata, indexName, documentId) {
      const parsed = {
        indexName: searchDocumentInputSchema.shape.indexName.parse(indexName),
        documentId:
          searchDocumentInputSchema.shape.documentId.parse(documentId),
      };
      return observeServiceOperation(
        "search.remove",
        {
          backend: "postgresql",
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.search.manage",
            metadata,
            async (transaction, resolved) => {
              const rowScope = resourceScopePredicate(
                resolved,
                "core.organization.search.manage",
                {
                  organizationId: searchDocuments.organizationId,
                  branchId: searchDocuments.branchId,
                },
              );
              if (!rowScope) return false;
              const [removed] = await transaction
                .delete(searchDocuments)
                .where(
                  and(
                    rowScope,
                    eq(searchDocuments.indexName, parsed.indexName),
                    eq(searchDocuments.documentId, parsed.documentId),
                  ),
                )
                .returning({ id: searchDocuments.id });
              if (!removed) return false;

              await writeAuthorizationMutationEvent(
                transaction,
                resolved,
                metadata,
                "SEARCH_DOCUMENT_DELETED",
                "search_document",
                removed.id,
                parsed,
              );
              await recordOutboxEvent(
                transaction,
                platformEvent(
                  resolved,
                  "SEARCH_DOCUMENT_DELETED",
                  "search_document",
                  removed.id,
                  parsed,
                  metadata.requestId,
                  metadata.correlationId ?? metadata.requestId,
                ),
              );
              return true;
            },
          ),
      );
    },

    async search(context, metadata, input) {
      const parsed = searchRequestSchema.parse(input);
      return observeServiceOperation(
        "search.query",
        {
          backend: "postgresql",
          queryLength: parsed.query.length,
          limit: parsed.limit,
          offset: parsed.offset,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.search.read",
            metadata,
            async (transaction, resolved) => {
              if (!branchInputMatches(parsed.branchId, resolved)) return [];
              const rowScope = resourceScopePredicate(
                resolved,
                "core.organization.search.read",
                {
                  organizationId: searchDocuments.organizationId,
                  branchId: searchDocuments.branchId,
                },
              );
              if (!rowScope) return [];
              const query = sql`websearch_to_tsquery('simple', ${parsed.query})`;
              const rank = sql<number>`ts_rank(
            to_tsvector('simple', coalesce(${searchDocuments.title}, '') || ' ' || coalesce(${searchDocuments.body}, '')),
            ${query}
          )`;
              const rows = await transaction
                .select({
                  documentId: searchDocuments.documentId,
                  indexName: searchDocuments.indexName,
                  title: searchDocuments.title,
                  body: searchDocuments.body,
                  branchId: searchDocuments.branchId,
                  updatedAt: searchDocuments.updatedAt,
                })
                .from(searchDocuments)
                .where(
                  and(
                    rowScope,
                    eq(searchDocuments.indexName, parsed.indexName),
                    sql`to_tsvector('simple', coalesce(${searchDocuments.title}, '') || ' ' || coalesce(${searchDocuments.body}, '')) @@ ${query}`,
                  ),
                )
                .orderBy(desc(rank), desc(searchDocuments.updatedAt))
                .limit(parsed.limit)
                .offset(parsed.offset);
              return rows.map(({ body, ...row }) => ({
                ...row,
                excerpt: body.slice(0, 240),
              }));
            },
          ),
        (result) => ({
          resultCount: result.allowed ? (result.value?.length ?? 0) : 0,
        }),
      );
    },
  };
}

function cryptoUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError("Expected a valid UUID");
  }
  return value;
}
