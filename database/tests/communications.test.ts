import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  OrganizationTransaction,
  ResolvedAuthorizationContext,
} from "../src/index.js";
import {
  createCommunicationService,
  createPlatformServices,
} from "../src/index.js";
import {
  createCommunicationDeliveryWorker,
  createCommunicationProviderRegistry,
} from "../src/index.js";
import type {
  CommunicationProvider,
  CommunicationProviderInput,
  SecretReference,
  SecretStore,
} from "@onecore/core-domain";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
let client: PGlite;
let database: ReturnType<typeof drizzle>;

async function createOrganization(name: string) {
  const [organization] = await database
    .insert(schema.organizations)
    .values({
      name,
      slug: `${name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID()}`,
      industry: "TEST",
      status: "ACTIVE",
      deploymentType: "SAAS",
    })
    .returning();
  if (!organization) throw new Error("Organization fixture was not created");
  return organization;
}

async function asTenant<T>(
  organizationId: string,
  action: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return client.transaction(async (transaction) => {
    await transaction.exec("SET LOCAL ROLE onecore_app");
    await transaction.query(
      "SELECT set_config('app.current_organization_id', $1, true)",
      [organizationId],
    );
    return action(transaction);
  });
}

function communicationTestAuthorization(): AuthorizationService {
  return {
    withPermission: async <T>(
      context: AuthorizationContext | null,
      _permissionKey: string,
      _metadata: AuthorizationMetadata,
      operation: (
        transaction: OrganizationTransaction,
        context: ResolvedAuthorizationContext,
      ) => Promise<T>,
    ): Promise<AuthorizationResult<T>> => {
      if (!context?.organizationId || !context.membershipId) {
        return {
          allowed: false,
          statusCode: context ? 403 : 401,
          dataScopes: [],
        };
      }
      const resolved: ResolvedAuthorizationContext = {
        userId: context.userId,
        sessionId: context.sessionId,
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        branchId: null,
        branch: null,
        branchAccessMode: "ALL",
        roles: [],
        platformRoles: [],
        permissions: [],
      };
      const value = await database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
        await transaction.execute(
          sql`SELECT set_config('app.current_user_id', ${resolved.userId}, true)`,
        );
        await transaction.execute(
          sql`SELECT set_config('app.current_organization_id', ${resolved.organizationId}, true)`,
        );
        return operation(
          transaction as unknown as OrganizationTransaction,
          resolved,
        );
      });
      return { allowed: true, value, context: resolved };
    },
  } as unknown as AuthorizationService;
}

describe("communication tenant persistence", () => {
  beforeAll(async () => {
    client = new PGlite();
    database = drizzle({ client });
    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    `);
    await applyTestMigrations(client, migrationsDirectory);
    await client.exec(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onecore_app",
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it("migrates the self-scoped notification permissions", async () => {
    const expected = [
      "core.organization.notification_inbox.read",
      "core.organization.notification_inbox.update_self",
      "core.organization.notification_preferences.read_self",
      "core.organization.notification_preferences.update_self",
    ];
    const permissions = await database
      .select({ key: schema.permissions.key })
      .from(schema.permissions)
      .where(inArray(schema.permissions.key, expected));
    expect(permissions.map(({ key }) => key).sort()).toEqual(expected.sort());
  });

  it("isolates every communications table and rejects cross-tenant writes", async () => {
    const organizationA = await createOrganization("Communication Tenant A");
    const organizationB = await createOrganization("Communication Tenant B");
    const [userA] = await database
      .insert(schema.users)
      .values({
        email: `communications-a-${crypto.randomUUID()}@example.test`,
        displayName: "Communication A",
        status: "ACTIVE",
      })
      .returning();
    const [userB] = await database
      .insert(schema.users)
      .values({
        email: `communications-b-${crypto.randomUUID()}@example.test`,
        displayName: "Communication B",
        status: "ACTIVE",
      })
      .returning();
    if (!userA || !userB)
      throw new Error("Communication users were not created");
    await database.insert(schema.organizationMemberships).values([
      {
        organizationId: organizationA.id,
        userId: userA.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      },
      {
        organizationId: organizationB.id,
        userId: userB.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      },
    ]);

    const setupTenant = async (
      organizationId: string,
      userId: string,
      suffix: string,
    ) => {
      const [integration] = await database
        .insert(schema.integrations)
        .values({
          organizationId,
          key: `email-${suffix}`,
          provider: "EMAIL_PROVIDER",
          secretReference: `opaque-${suffix}-reference`,
        })
        .returning();
      if (!integration) throw new Error("Integration fixture was not created");
      const [providerConfig] = await database
        .insert(schema.communicationProviderConfigs)
        .values({
          organizationId,
          integrationId: integration.id,
          channel: "EMAIL",
          providerKey: "test.email",
          status: "ACTIVE",
          configuration: { senderName: "OneCore" },
        })
        .returning();
      const [template] = await database
        .insert(schema.communicationTemplates)
        .values({ organizationId, key: "account.notice", channel: "EMAIL" })
        .returning();
      if (!providerConfig || !template) {
        throw new Error("Communication provider/template fixture missing");
      }
      const [version] = await database
        .insert(schema.communicationTemplateVersions)
        .values({
          organizationId,
          templateId: template.id,
          version: 1,
          locale: "en",
          subject: "Test",
          body: "Test message body",
          variables: [],
          status: "PUBLISHED",
          publishedAt: new Date(),
        })
        .returning();
      if (!version) throw new Error("Template version was not created");
      const [event] = await database
        .insert(schema.outboxEvents)
        .values({
          eventType: "COMMUNICATION_QUEUED",
          aggregateType: "communication_message",
          aggregateId: crypto.randomUUID(),
          organizationId,
          payload: {
            messageId: crypto.randomUUID(),
            deliveryId: crypto.randomUUID(),
            channel: "EMAIL",
            category: "ACCOUNT_NOTICE",
          },
          metadata: {},
        })
        .returning();
      if (!event) throw new Error("Source event was not created");
      const [message] = await database
        .insert(schema.communicationMessages)
        .values({
          organizationId,
          recipientUserId: userId,
          channel: "EMAIL",
          category: "ACCOUNT_NOTICE",
          templateVersionId: version.id,
          subject: "Test",
          renderedContent: `Sensitive test-only content ${suffix}`,
          contentHashSha256: "a".repeat(64),
          correlationId: crypto.randomUUID(),
          sourceEventId: event.id,
          idempotencyKey: `message-${suffix}`,
        })
        .returning();
      if (!message) throw new Error("Message fixture was not created");
      const [delivery] = await database
        .insert(schema.communicationDeliveries)
        .values({
          organizationId,
          messageId: message.id,
          providerConfigId: providerConfig.id,
          status: "QUEUED",
        })
        .returning();
      if (!delivery) throw new Error("Delivery fixture was not created");
      await database.insert(schema.communicationDeliveryAttempts).values({
        organizationId,
        deliveryId: delivery.id,
        attemptNumber: 1,
        status: "RETRYING",
        failureClass: "RETRYABLE",
        failureCode: "TEST_NETWORK_FAILURE",
      });
      await database.insert(schema.notificationPreferences).values([
        {
          organizationId,
          userId: null,
          channel: "EMAIL",
          category: "ACCOUNT_NOTICE",
          enabled: true,
        },
        {
          organizationId,
          userId,
          channel: "EMAIL",
          category: "ACCOUNT_NOTICE",
          enabled: true,
        },
      ]);
      return { providerConfig, template, message, delivery };
    };

    const resourcesA = await setupTenant(organizationA.id, userA.id, "a");
    const resourcesB = await setupTenant(organizationB.id, userB.id, "b");

    const visible = await asTenant(organizationA.id, async (transaction) => ({
      providers: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM communication_provider_configs",
      ),
      templates: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM communication_templates",
      ),
      versions: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM communication_template_versions",
      ),
      preferences: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM notification_preferences",
      ),
      messages: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM communication_messages",
      ),
      deliveries: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM communication_deliveries",
      ),
      attempts: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM communication_delivery_attempts",
      ),
      foreignMessageUpdate: await transaction.query(
        "UPDATE communication_messages SET status = 'CANCELLED' WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      foreignPreferenceUpdate: await transaction.query(
        "UPDATE notification_preferences SET enabled = false WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      foreignTemplateDelete: await transaction.query(
        "DELETE FROM communication_templates WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
    }));

    for (const rows of [
      visible.providers.rows,
      visible.templates.rows,
      visible.versions.rows,
      visible.preferences.rows,
      visible.messages.rows,
      visible.deliveries.rows,
      visible.attempts.rows,
    ]) {
      expect(
        rows.every(
          ({ organization_id }) => organization_id === organizationA.id,
        ),
      ).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    }
    expect(visible.foreignMessageUpdate.rows).toEqual([]);
    expect(visible.foreignPreferenceUpdate.rows).toEqual([]);
    expect(visible.foreignTemplateDelete.rows).toEqual([]);

    const missingContext = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      const messageRows = await transaction.query(
        "SELECT id FROM communication_messages",
      );
      const preferenceRows = await transaction.query(
        "SELECT id FROM notification_preferences",
      );
      return { messageRows, preferenceRows };
    });
    expect(missingContext.messageRows.rows).toEqual([]);
    expect(missingContext.preferenceRows.rows).toEqual([]);
    expect(resourcesA.message.organizationId).not.toBe(
      resourcesB.message.organizationId,
    );
  });

  it("queues a rendered message transactionally with locale, preferences, and idempotency", async () => {
    const organization = await createOrganization("Communication Queue Tenant");
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `communication-queue-${crypto.randomUUID()}@example.test`,
        displayName: "Communication Recipient",
        status: "ACTIVE",
      })
      .returning();
    if (!user) throw new Error("Communication recipient was not created");
    const [membership] = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organization.id,
        userId: user.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
        locale: "fr-CA",
      })
      .returning();
    if (!membership)
      throw new Error("Communication membership was not created");
    await database.insert(schema.organizationSettings).values({
      organizationId: organization.id,
      countryCode: "KE",
      currencyCode: "KES",
      timezone: "Africa/Nairobi",
      locale: "sw-KE",
    });
    const [integration] = await database
      .insert(schema.integrations)
      .values({
        organizationId: organization.id,
        key: "communication-email",
        provider: "EMAIL_PROVIDER",
        secretReference: "opaque-test-reference-only",
      })
      .returning();
    if (!integration) throw new Error("Provider integration was not created");
    await database.insert(schema.communicationProviderConfigs).values({
      organizationId: organization.id,
      integrationId: integration.id,
      channel: "EMAIL",
      providerKey: "test.email",
      status: "ACTIVE",
      configuration: { senderName: "OneCore" },
    });
    const [template] = await database
      .insert(schema.communicationTemplates)
      .values({
        organizationId: organization.id,
        key: "account.notice",
        channel: "EMAIL",
      })
      .returning();
    if (!template) throw new Error("Communication template was not created");
    const [version] = await database
      .insert(schema.communicationTemplateVersions)
      .values({
        organizationId: organization.id,
        templateId: template.id,
        version: 1,
        locale: "sw",
        subject: "Habari {{customer.name}}",
        body: "Hujambo {{customer.name}}, akaunti yako iko tayari.",
        variables: ["customer.name"],
        status: "PUBLISHED",
        publishedAt: new Date(),
      })
      .returning();
    if (!version) throw new Error("Published template was not created");
    await expect(
      database
        .update(schema.communicationTemplateVersions)
        .set({ body: "tampered published template" })
        .where(eq(schema.communicationTemplateVersions.id, version.id)),
    ).rejects.toThrow();
    const [immutableVersion] = await database
      .select({ body: schema.communicationTemplateVersions.body })
      .from(schema.communicationTemplateVersions)
      .where(eq(schema.communicationTemplateVersions.id, version.id));
    expect(immutableVersion?.body).toBe(
      "Hujambo {{customer.name}}, akaunti yako iko tayari.",
    );
    await database.insert(schema.notificationPreferences).values({
      organizationId: organization.id,
      userId: null,
      channel: "EMAIL",
      category: "ACCOUNT_NOTICE",
      enabled: true,
    });

    const service = createCommunicationService(
      communicationTestAuthorization(),
    );
    const context: AuthorizationContext = {
      userId: user.id,
      sessionId: crypto.randomUUID(),
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: null,
    };
    const metadata = {
      requestId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    };
    const request = {
      channel: "EMAIL",
      recipientUserId: user.id,
      category: "ACCOUNT_NOTICE",
      templateKey: "account.notice",
      variables: { "customer.name": "Ari" },
      idempotencyKey: "welcome-once",
    };
    const first = await service.enqueue(context, metadata, request);
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("Queue operation was not authorized");
    expect(first.value).toMatchObject({ outcome: "QUEUED", locale: "sw" });
    if (first.value.outcome !== "QUEUED") {
      throw new Error("Communication message was not queued");
    }

    const duplicate = await service.enqueue(context, metadata, request);
    expect(duplicate).toMatchObject({
      allowed: true,
      value: {
        outcome: "QUEUED",
        messageId: first.value.messageId,
        deliveryId: first.value.deliveryId,
      },
    });
    const conflicting = await service.enqueue(context, metadata, {
      ...request,
      variables: { "customer.name": "Different Recipient" },
    });
    expect(conflicting).toMatchObject({
      allowed: true,
      value: { outcome: "IDEMPOTENCY_CONFLICT" },
    });

    const [message] = await database
      .select()
      .from(schema.communicationMessages)
      .where(eq(schema.communicationMessages.id, first.value.messageId));
    expect(message).toMatchObject({
      subject: "Habari Ari",
      renderedContent: "Hujambo Ari, akaunti yako iko tayari.",
    });
    const [outbox] = await database
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, first.value.messageId));
    expect(outbox?.eventType).toBe("COMMUNICATION_QUEUED");
    expect(outbox?.payload).toMatchObject({
      messageId: first.value.messageId,
      deliveryId: first.value.deliveryId,
      channel: "EMAIL",
      category: "ACCOUNT_NOTICE",
    });
    expect(JSON.stringify(outbox?.payload)).not.toContain("Ari");
    expect(JSON.stringify(outbox?.payload)).not.toContain(
      "opaque-test-reference-only",
    );

    await database.insert(schema.notificationPreferences).values({
      organizationId: organization.id,
      userId: user.id,
      channel: "EMAIL",
      category: "ACCOUNT_NOTICE",
      enabled: false,
    });
    const suppressed = await service.enqueue(context, metadata, {
      ...request,
      idempotencyKey: "welcome-suppressed",
    });
    expect(suppressed).toMatchObject({
      allowed: true,
      value: { outcome: "SUPPRESSED" },
    });

    const providerInputs: CommunicationProviderInput[] = [];
    let providerAttempts = 0;
    const testProvider: CommunicationProvider = {
      providerKey: "test.email",
      channel: "EMAIL",
      validateConfiguration: (configuration) =>
        typeof configuration === "object" && configuration !== null,
      async send(input, credential) {
        providerInputs.push(input);
        expect(new TextDecoder().decode(credential)).toBe(
          "deterministic-test-provider-credential",
        );
        providerAttempts += 1;
        return providerAttempts === 1
          ? {
              outcome: "RETRYABLE_FAILURE",
              failureCode: "TEST_TRANSIENT_PROVIDER_FAILURE",
              retryAfterSeconds: 1,
            }
          : {
              outcome: "SENT",
              providerMessageId: "test-provider-message-1",
            };
      },
    };
    const testSecretStore: SecretStore = {
      store: async () => "unused-test-reference" as SecretReference,
      rotate: async ({ reference }) => reference,
      withSecret: async (input, use) => {
        expect(input.organizationId).toBe(organization.id);
        expect(input.purpose).toBe("INTEGRATION_CREDENTIAL");
        expect(input.reference).toBe("opaque-test-reference-only");
        return use(
          new TextEncoder().encode("deterministic-test-provider-credential"),
        );
      },
      delete: async () => undefined,
      metadata: async () => undefined,
    };
    const worker = createCommunicationDeliveryWorker(
      database as unknown as import("../src/index.js").Database,
      testSecretStore,
      createCommunicationProviderRegistry([testProvider]),
    );
    const firstAttemptTime = new Date(Date.now() + 60_000);
    const firstAttempt = await worker.processTenantBatch(organization.id, {
      now: firstAttemptTime,
    });
    expect(firstAttempt).toMatchObject({ claimed: 1, retrying: 1 });
    const secondAttempt = await worker.processTenantBatch(organization.id, {
      now: new Date(firstAttemptTime.getTime() + 60_000),
    });
    expect(secondAttempt).toMatchObject({ claimed: 1, sent: 1 });
    expect(providerInputs).toHaveLength(2);
    expect(providerInputs[0]?.deliveryId).toBe(first.value.deliveryId);
    expect(providerInputs[1]?.deliveryId).toBe(first.value.deliveryId);
    expect(providerInputs[0]?.idempotencyKey).toBe(first.value.deliveryId);
    const attempts = await database
      .select()
      .from(schema.communicationDeliveryAttempts)
      .where(
        eq(
          schema.communicationDeliveryAttempts.deliveryId,
          first.value.deliveryId,
        ),
      );
    expect(attempts.map(({ status }) => status)).toEqual(["RETRYING", "SENT"]);
    const [deliveredMessage] = await database
      .select({
        status: schema.communicationMessages.status,
        subject: schema.communicationMessages.subject,
        renderedContent: schema.communicationMessages.renderedContent,
      })
      .from(schema.communicationMessages)
      .where(eq(schema.communicationMessages.id, first.value.messageId));
    expect(deliveredMessage?.status).toBe("SENT");
    expect(deliveredMessage?.subject).toBeNull();
    expect(deliveredMessage?.renderedContent).toBe("");

    await database
      .update(schema.notificationPreferences)
      .set({ enabled: true })
      .where(eq(schema.notificationPreferences.userId, user.id));
    const retryOnlyRequest = {
      ...request,
      idempotencyKey: "welcome-dead-letter",
    };
    const retryOnlyQueued = await service.enqueue(
      context,
      metadata,
      retryOnlyRequest,
    );
    expect(retryOnlyQueued.allowed).toBe(true);
    if (
      !retryOnlyQueued.allowed ||
      retryOnlyQueued.value.outcome !== "QUEUED"
    ) {
      throw new Error("Retry-only communication message was not queued");
    }
    const retryDeliveryIds: string[] = [];
    const retryOnlyProvider: CommunicationProvider = {
      providerKey: "test.email",
      channel: "EMAIL",
      validateConfiguration: (configuration) =>
        typeof configuration === "object" && configuration !== null,
      async send(input) {
        retryDeliveryIds.push(input.deliveryId);
        return {
          outcome: "RETRYABLE_FAILURE",
          failureCode: "TEST_RETRY_UNTIL_EXHAUSTED",
        };
      },
    };
    const retryOnlyWorker = createCommunicationDeliveryWorker(
      database as unknown as import("../src/index.js").Database,
      testSecretStore,
      createCommunicationProviderRegistry([retryOnlyProvider]),
    );
    const retryStart = new Date(Date.now() + 60_000);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const attemptResult = await retryOnlyWorker.processTenantBatch(
        organization.id,
        { now: new Date(retryStart.getTime() + attempt * 60_000) },
      );
      if (attempt < 5) {
        expect(attemptResult).toMatchObject({ claimed: 1, retrying: 1 });
      } else {
        expect(attemptResult).toMatchObject({ claimed: 1, deadLettered: 1 });
      }
    }
    expect(retryDeliveryIds).toEqual(
      Array(5).fill(retryOnlyQueued.value.deliveryId),
    );
    const [deadLetteredDelivery] = await database
      .select()
      .from(schema.communicationDeliveries)
      .where(
        eq(schema.communicationDeliveries.id, retryOnlyQueued.value.deliveryId),
      );
    expect(deadLetteredDelivery).toMatchObject({
      status: "DEAD_LETTER",
      attemptCount: 5,
      lastFailureCode: "MAX_ATTEMPTS_EXHAUSTED",
    });
    const [deadLetteredMessage] = await database
      .select({ renderedContent: schema.communicationMessages.renderedContent })
      .from(schema.communicationMessages)
      .where(
        eq(schema.communicationMessages.id, retryOnlyQueued.value.messageId),
      );
    expect(deadLetteredMessage?.renderedContent).toBe("");
    const retryAttempts = await database
      .select()
      .from(schema.communicationDeliveryAttempts)
      .where(
        eq(
          schema.communicationDeliveryAttempts.deliveryId,
          retryOnlyQueued.value.deliveryId,
        ),
      );
    expect(retryAttempts).toHaveLength(5);
    expect(retryAttempts.at(-1)?.status).toBe("DEAD_LETTER");

    const permanentFailureQueued = await service.enqueue(context, metadata, {
      ...request,
      idempotencyKey: "welcome-permanent-failure",
    });
    expect(permanentFailureQueued.allowed).toBe(true);
    if (
      !permanentFailureQueued.allowed ||
      permanentFailureQueued.value.outcome !== "QUEUED"
    ) {
      throw new Error("Permanent-failure communication message was not queued");
    }
    const permanentFailureWorker = createCommunicationDeliveryWorker(
      database as unknown as import("../src/index.js").Database,
      testSecretStore,
      createCommunicationProviderRegistry([
        {
          providerKey: "test.email",
          channel: "EMAIL",
          validateConfiguration: () => true,
          async send() {
            return {
              outcome: "PERMANENT_FAILURE",
              failureCode: "TEST_PERMANENT_FAILURE",
            };
          },
        },
      ]),
    );
    const permanentFailureResult =
      await permanentFailureWorker.processTenantBatch(organization.id, {
        now: new Date(retryStart.getTime() + 20 * 60_000),
      });
    expect(permanentFailureResult).toMatchObject({ claimed: 1, failed: 1 });
    const [permanentlyFailedMessage] = await database
      .select({
        status: schema.communicationMessages.status,
        subject: schema.communicationMessages.subject,
        renderedContent: schema.communicationMessages.renderedContent,
      })
      .from(schema.communicationMessages)
      .where(
        eq(
          schema.communicationMessages.id,
          permanentFailureQueued.value.messageId,
        ),
      );
    expect(permanentlyFailedMessage).toEqual({
      status: "FAILED",
      subject: null,
      renderedContent: "",
    });

    const staleLeaseQueued = await service.enqueue(context, metadata, {
      ...request,
      idempotencyKey: "welcome-stale-lease",
    });
    expect(staleLeaseQueued.allowed).toBe(true);
    if (
      !staleLeaseQueued.allowed ||
      staleLeaseQueued.value.outcome !== "QUEUED"
    ) {
      throw new Error("Stale-lease communication message was not queued");
    }
    await database
      .update(schema.communicationDeliveries)
      .set({
        status: "SENDING",
        attemptCount: 5,
        leaseExpiresAt: new Date(retryStart.getTime() - 1),
      })
      .where(
        eq(
          schema.communicationDeliveries.id,
          staleLeaseQueued.value.deliveryId,
        ),
      );
    await database
      .update(schema.communicationMessages)
      .set({ status: "SENDING" })
      .where(
        eq(schema.communicationMessages.id, staleLeaseQueued.value.messageId),
      );

    const staleLeaseResult = await retryOnlyWorker.processTenantBatch(
      organization.id,
      { now: new Date(retryStart.getTime() + 10 * 60_000) },
    );
    expect(staleLeaseResult).toMatchObject({ claimed: 0 });
    const [staleLeaseMessage] = await database
      .select({
        status: schema.communicationMessages.status,
        subject: schema.communicationMessages.subject,
        renderedContent: schema.communicationMessages.renderedContent,
      })
      .from(schema.communicationMessages)
      .where(
        eq(schema.communicationMessages.id, staleLeaseQueued.value.messageId),
      );
    expect(staleLeaseMessage).toEqual({
      status: "DEAD_LETTER",
      subject: null,
      renderedContent: "",
    });
  });

  it("applies user-over-organization preferences to existing in-app notifications", async () => {
    const organization = await createOrganization("In-App Preference Tenant");
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `in-app-preference-${crypto.randomUUID()}@example.test`,
        displayName: "In-App Preference User",
        status: "ACTIVE",
      })
      .returning();
    if (!user) throw new Error("In-app preference user was not created");
    const [membership] = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organization.id,
        userId: user.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      })
      .returning();
    if (!membership) {
      throw new Error("In-app preference membership was not created");
    }
    const platform = createPlatformServices(communicationTestAuthorization());
    const context: AuthorizationContext = {
      userId: user.id,
      sessionId: crypto.randomUUID(),
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: null,
    };
    const metadata = { requestId: crypto.randomUUID() };
    const input = {
      recipientUserId: user.id,
      notificationType: "platform.notice",
      title: "Platform notice",
      body: "A test notice",
    };

    const platformDefault = await platform.createNotification(
      context,
      metadata,
      input,
    );
    expect(platformDefault).toMatchObject({
      allowed: true,
      value: { id: expect.any(String) },
    });

    await database.insert(schema.notificationPreferences).values({
      organizationId: organization.id,
      userId: null,
      channel: "IN_APP",
      category: input.notificationType,
      enabled: false,
    });
    const organizationDefault = await platform.createNotification(
      context,
      metadata,
      { ...input, title: "Suppressed by organization default" },
    );
    expect(organizationDefault).toMatchObject({ allowed: true, value: null });

    await database.insert(schema.notificationPreferences).values({
      organizationId: organization.id,
      userId: user.id,
      channel: "IN_APP",
      category: input.notificationType,
      enabled: true,
    });
    const userOverride = await platform.createNotification(context, metadata, {
      ...input,
      title: "User override",
    });
    expect(userOverride).toMatchObject({
      allowed: true,
      value: { id: expect.any(String) },
    });
  });
});
