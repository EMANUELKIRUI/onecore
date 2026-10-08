import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  communicationTemplateInputSchema,
  communicationLocaleFallbackChain,
  createDomainEvent,
  queueCommunicationInputSchema,
  type CommunicationStatus,
  renderCommunicationTemplate,
  resolveCommunicationPreference,
} from "@onecore/core-domain";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
} from "./authorization.js";
import { writeAuthorizationMutationEvent } from "./authorization.js";
import {
  communicationDeliveries,
  communicationMessages,
  communicationProviderConfigs,
  communicationTemplateVersions,
  communicationTemplates,
  integrations,
  notificationPreferences,
  organizationMemberships,
  organizationSettings,
  users,
} from "../schema/index.js";
import { recordOutboxEvent } from "./outbox.js";

export type QueueCommunicationOutcome =
  | {
      outcome: "QUEUED";
      messageId: string;
      deliveryId: string;
      templateVersionId: string;
      locale: string;
      status: CommunicationStatus;
    }
  | { outcome: "SUPPRESSED" }
  | { outcome: "TEMPLATE_NOT_FOUND" }
  | { outcome: "PROVIDER_NOT_CONFIGURED" }
  | { outcome: "IDEMPOTENCY_CONFLICT" };

export interface CommunicationService {
  enqueue(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    input: unknown,
  ): Promise<AuthorizationResult<QueueCommunicationOutcome>>;
}

function platformPreference(channel: string): boolean {
  return channel === "IN_APP";
}

function stableContentHash(input: {
  channel: string;
  recipientUserId: string;
  category: string;
  templateVersionId: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown>;
}): string {
  function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object" && value !== null) {
      return `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function createCommunicationService(
  authorization: AuthorizationService,
): CommunicationService {
  return {
    async enqueue(context, metadata, input) {
      const parsed = queueCommunicationInputSchema.parse(input);
      return authorization.withPermission(
        context,
        "core.organization.notifications.manage",
        metadata,
        async (transaction, resolved) => {
          const [recipient] = await transaction
            .select({
              userId: organizationMemberships.userId,
              locale: organizationMemberships.locale,
            })
            .from(organizationMemberships)
            .innerJoin(users, eq(users.id, organizationMemberships.userId))
            .where(
              and(
                eq(
                  organizationMemberships.organizationId,
                  resolved.organizationId,
                ),
                eq(organizationMemberships.userId, parsed.recipientUserId),
                eq(organizationMemberships.status, "ACTIVE"),
                eq(users.status, "ACTIVE"),
              ),
            )
            .limit(1);
          if (!recipient) return { outcome: "SUPPRESSED" };

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
                eq(notificationPreferences.channel, parsed.channel),
                eq(notificationPreferences.category, parsed.category),
                or(
                  isNull(notificationPreferences.userId),
                  eq(notificationPreferences.userId, parsed.recipientUserId),
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
              platformDefault: platformPreference(parsed.channel),
              ...(organizationDefault === undefined
                ? {}
                : { organizationDefault }),
              ...(userOverride === undefined ? {} : { userOverride }),
            })
          ) {
            return { outcome: "SUPPRESSED" };
          }

          const [settings] = await transaction
            .select({ locale: organizationSettings.locale })
            .from(organizationSettings)
            .where(
              eq(organizationSettings.organizationId, resolved.organizationId),
            )
            .limit(1);
          const organizationLocale = settings?.locale ?? "en";
          const requestedLocale =
            parsed.locale ?? recipient.locale ?? organizationLocale;
          const localeFallbacks = communicationLocaleFallbackChain(
            requestedLocale,
            organizationLocale,
          );
          const versions = await transaction
            .select({
              templateId: communicationTemplates.id,
              templateKey: communicationTemplates.key,
              templateChannel: communicationTemplates.channel,
              versionId: communicationTemplateVersions.id,
              version: communicationTemplateVersions.version,
              locale: communicationTemplateVersions.locale,
              subject: communicationTemplateVersions.subject,
              body: communicationTemplateVersions.body,
              variables: communicationTemplateVersions.variables,
            })
            .from(communicationTemplateVersions)
            .innerJoin(
              communicationTemplates,
              and(
                eq(
                  communicationTemplates.organizationId,
                  communicationTemplateVersions.organizationId,
                ),
                eq(
                  communicationTemplates.id,
                  communicationTemplateVersions.templateId,
                ),
              ),
            )
            .where(
              and(
                eq(
                  communicationTemplateVersions.organizationId,
                  resolved.organizationId,
                ),
                eq(communicationTemplateVersions.status, "PUBLISHED"),
                eq(communicationTemplates.status, "ACTIVE"),
                eq(communicationTemplates.key, parsed.templateKey),
                eq(communicationTemplates.channel, parsed.channel),
                inArray(communicationTemplateVersions.locale, localeFallbacks),
              ),
            );
          const version = localeFallbacks
            .map((locale) =>
              versions.find((candidate) => candidate.locale === locale),
            )
            .find((candidate) => candidate !== undefined);
          if (!version) return { outcome: "TEMPLATE_NOT_FOUND" };

          const template = communicationTemplateInputSchema.parse({
            key: version.templateKey,
            channel: version.templateChannel,
            locale: version.locale,
            ...(version.subject === null ? {} : { subject: version.subject }),
            body: version.body,
            variables: version.variables,
          });
          const rendered = renderCommunicationTemplate(
            template,
            parsed.variables,
          );
          const [providerConfig] = await transaction
            .select({
              id: communicationProviderConfigs.id,
              providerKey: communicationProviderConfigs.providerKey,
              integrationStatus: integrations.status,
              hasCredential: integrations.secretReference,
            })
            .from(communicationProviderConfigs)
            .innerJoin(
              integrations,
              and(
                eq(
                  integrations.organizationId,
                  communicationProviderConfigs.organizationId,
                ),
                eq(integrations.id, communicationProviderConfigs.integrationId),
              ),
            )
            .where(
              and(
                eq(
                  communicationProviderConfigs.organizationId,
                  resolved.organizationId,
                ),
                eq(communicationProviderConfigs.channel, parsed.channel),
                eq(communicationProviderConfigs.status, "ACTIVE"),
              ),
            )
            .limit(1);
          if (
            !providerConfig ||
            !providerConfig.hasCredential ||
            !["PENDING", "ACTIVE"].includes(providerConfig.integrationStatus)
          ) {
            return { outcome: "PROVIDER_NOT_CONFIGURED" };
          }

          const body = rendered.body;
          const subject = rendered.subject;
          const contentHashSha256 = stableContentHash({
            channel: parsed.channel,
            recipientUserId: parsed.recipientUserId,
            category: parsed.category,
            templateVersionId: version.versionId,
            subject,
            body,
            metadata: parsed.metadata,
          });
          if (parsed.idempotencyKey) {
            const [existing] = await transaction
              .select({
                id: communicationMessages.id,
                contentHashSha256: communicationMessages.contentHashSha256,
                status: communicationMessages.status,
              })
              .from(communicationMessages)
              .where(
                and(
                  eq(
                    communicationMessages.organizationId,
                    resolved.organizationId,
                  ),
                  eq(
                    communicationMessages.idempotencyKey,
                    parsed.idempotencyKey,
                  ),
                ),
              )
              .limit(1);
            if (existing) {
              if (existing.contentHashSha256 !== contentHashSha256) {
                return { outcome: "IDEMPOTENCY_CONFLICT" };
              }
              const [delivery] = await transaction
                .select({
                  id: communicationDeliveries.id,
                  status: communicationDeliveries.status,
                })
                .from(communicationDeliveries)
                .where(
                  and(
                    eq(
                      communicationDeliveries.organizationId,
                      resolved.organizationId,
                    ),
                    eq(communicationDeliveries.messageId, existing.id),
                  ),
                )
                .limit(1);
              if (!delivery) return { outcome: "IDEMPOTENCY_CONFLICT" };
              return {
                outcome: "QUEUED",
                messageId: existing.id,
                deliveryId: delivery.id,
                templateVersionId: version.versionId,
                locale: version.locale,
                status: delivery.status,
              };
            }
          }

          const [message] = await transaction
            .insert(communicationMessages)
            .values({
              organizationId: resolved.organizationId,
              recipientUserId: parsed.recipientUserId,
              channel: parsed.channel,
              category: parsed.category,
              templateVersionId: version.versionId,
              subject,
              renderedContent: body,
              contentHashSha256,
              metadata: parsed.metadata,
              status: "QUEUED",
              priority: parsed.priority,
              correlationId: metadata.correlationId ?? metadata.requestId,
              sourceEventId: parsed.sourceEventId ?? null,
              idempotencyKey: parsed.idempotencyKey ?? null,
              createdByUserId: resolved.userId,
              scheduledAt: parsed.scheduledAt
                ? new Date(parsed.scheduledAt)
                : new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: communicationMessages.id });
          if (!message) {
            if (!parsed.idempotencyKey) {
              throw new Error("COMMUNICATION_MESSAGE_INSERT_FAILED");
            }
            const [existing] = await transaction
              .select({
                id: communicationMessages.id,
                contentHashSha256: communicationMessages.contentHashSha256,
                status: communicationMessages.status,
              })
              .from(communicationMessages)
              .where(
                and(
                  eq(
                    communicationMessages.organizationId,
                    resolved.organizationId,
                  ),
                  eq(
                    communicationMessages.idempotencyKey,
                    parsed.idempotencyKey,
                  ),
                ),
              )
              .limit(1);
            if (!existing || existing.contentHashSha256 !== contentHashSha256) {
              return { outcome: "IDEMPOTENCY_CONFLICT" };
            }
            const [existingDelivery] = await transaction
              .select({
                id: communicationDeliveries.id,
                status: communicationDeliveries.status,
              })
              .from(communicationDeliveries)
              .where(
                and(
                  eq(
                    communicationDeliveries.organizationId,
                    resolved.organizationId,
                  ),
                  eq(communicationDeliveries.messageId, existing.id),
                ),
              )
              .limit(1);
            if (!existingDelivery) return { outcome: "IDEMPOTENCY_CONFLICT" };
            return {
              outcome: "QUEUED",
              messageId: existing.id,
              deliveryId: existingDelivery.id,
              templateVersionId: version.versionId,
              locale: version.locale,
              status: existingDelivery.status,
            };
          }

          const [delivery] = await transaction
            .insert(communicationDeliveries)
            .values({
              organizationId: resolved.organizationId,
              messageId: message.id,
              providerConfigId: providerConfig.id,
              status: "QUEUED",
              maxAttempts: 5,
              nextAttemptAt: parsed.scheduledAt
                ? new Date(parsed.scheduledAt)
                : new Date(),
            })
            .returning({ id: communicationDeliveries.id });
          if (!delivery)
            throw new Error("COMMUNICATION_DELIVERY_INSERT_FAILED");

          await writeAuthorizationMutationEvent(
            transaction,
            resolved,
            metadata,
            "COMMUNICATION_QUEUED",
            "communication_message",
            message.id,
            {
              deliveryId: delivery.id,
              channel: parsed.channel,
              category: parsed.category,
              templateVersionId: version.versionId,
              recipientUserId: parsed.recipientUserId,
            },
          );
          await recordOutboxEvent(
            transaction,
            createDomainEvent({
              eventType: "COMMUNICATION_QUEUED",
              organizationId: resolved.organizationId,
              actorUserId: resolved.userId,
              correlationId: metadata.correlationId ?? metadata.requestId,
              ...(parsed.sourceEventId
                ? { causationId: parsed.sourceEventId }
                : {}),
              aggregateType: "communication_message",
              aggregateId: message.id,
              payload: {
                messageId: message.id,
                deliveryId: delivery.id,
                channel: parsed.channel,
                category: parsed.category,
              },
              metadata: { requestId: metadata.requestId },
            }),
          );
          return {
            outcome: "QUEUED",
            messageId: message.id,
            deliveryId: delivery.id,
            templateVersionId: version.versionId,
            locale: version.locale,
            status: "QUEUED",
          };
        },
      );
    },
  };
}
