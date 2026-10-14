import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrganizationTransaction } from "../src/index.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

let client: PGlite;
let database: ReturnType<typeof drizzle>;
let organizationId: string;
let otherOrganizationId: string;
let customerId: string;
let supportUserId: string;
let requestId: string;
let otherRequestId: string;

async function asApplicationUser<T>(
  userId: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`select set_config('app.current_user_id', ${userId}, true)`,
    );
    return operation(transaction as unknown as OrganizationTransaction);
  });
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle({ client });
  await client.exec(`
    CREATE ROLE onecore_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  `);
  await applyTestMigrations(client, migrationsDirectory);

  organizationId = crypto.randomUUID();
  otherOrganizationId = crypto.randomUUID();
  customerId = crypto.randomUUID();
  supportUserId = crypto.randomUUID();
  const otherCustomerId = crypto.randomUUID();
  requestId = crypto.randomUUID();
  otherRequestId = crypto.randomUUID();
  const now = new Date();

  await database.insert(schema.organizations).values([
    {
      id: organizationId,
      name: "Support Test Organization",
      slug: `support-${organizationId.slice(0, 8)}`,
      industry: "Testing",
      status: "ACTIVE",
    },
    {
      id: otherOrganizationId,
      name: "Other Test Organization",
      slug: `other-${otherOrganizationId.slice(0, 8)}`,
      industry: "Testing",
      status: "ACTIVE",
    },
  ]);
  await database.insert(schema.users).values([
    {
      id: customerId,
      email: `customer-${customerId}@example.test`,
      displayName: "Support Customer",
      status: "ACTIVE",
    },
    {
      id: supportUserId,
      email: `support-${supportUserId}@example.test`,
      displayName: "Assigned Support",
      status: "ACTIVE",
    },
    {
      id: otherCustomerId,
      email: `other-${otherCustomerId}@example.test`,
      displayName: "Other Customer",
      status: "ACTIVE",
    },
  ]);
  await database.insert(schema.organizationMemberships).values([
    { organizationId, userId: customerId, status: "ACTIVE" },
    {
      organizationId: otherOrganizationId,
      userId: otherCustomerId,
      status: "ACTIVE",
    },
  ]);
  await database.insert(schema.platformUserRoles).values({
    userId: supportUserId,
    role: "SUPPORT",
  });
  const [grant] = await database
    .insert(schema.supportAccessGrants)
    .values({
      organizationId,
      supportUserId,
      grantedByUserId: customerId,
      reason: "Fixture access for support RLS tests",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    })
    .returning();
  if (!grant) throw new Error("Support fixture grant was not created");
  await database.insert(schema.supportRequests).values([
    {
      id: requestId,
      organizationId,
      createdByUserId: customerId,
      assignedSupportUserId: supportUserId,
      subject: "Visible assigned request",
    },
    {
      id: otherRequestId,
      organizationId: otherOrganizationId,
      createdByUserId: otherCustomerId,
      assignedSupportUserId: supportUserId,
      subject: "Un-granted organization request",
    },
  ]);
  await database.insert(schema.supportMessages).values([
    {
      organizationId,
      requestId,
      authorUserId: customerId,
      visibility: "CUSTOMER",
      body: "Customer-visible reply",
    },
    {
      organizationId,
      requestId,
      authorUserId: supportUserId,
      visibility: "INTERNAL",
      body: "Staff-only note",
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe("Support workspace row-level security", () => {
  it("allows organization members to create requests only for their active tenant", async () => {
    const createdId = crypto.randomUUID();
    const created = await asApplicationUser(customerId, (transaction) =>
      transaction
        .insert(schema.supportRequests)
        .values({
          id: createdId,
          organizationId,
          createdByUserId: customerId,
          subject: "Customer-created request",
        })
        .returning(),
    );
    expect(created.map(({ id }) => id)).toEqual([createdId]);

    await expect(
      asApplicationUser(customerId, (transaction) =>
        transaction
          .insert(schema.supportRequests)
          .values({
            organizationId: otherOrganizationId,
            createdByUserId: customerId,
            subject: "Forged organization request",
          })
          .returning(),
      ),
    ).rejects.toThrow();
  });

  it("limits customers to their organization's requests and customer-visible messages", async () => {
    const visibleRequests = await asApplicationUser(customerId, (transaction) =>
      transaction.select().from(schema.supportRequests),
    );
    const visibleMessages = await asApplicationUser(customerId, (transaction) =>
      transaction.select().from(schema.supportMessages),
    );

    expect(visibleRequests.map(({ id }) => id)).toEqual(
      expect.arrayContaining([requestId]),
    );
    expect(visibleRequests).toHaveLength(2);
    expect(visibleMessages.map(({ body }) => body)).toEqual([
      "Customer-visible reply",
    ]);
  });

  it("allows assigned staff to update requests and keeps internal notes staff-only", async () => {
    const updated = await asApplicationUser(supportUserId, (transaction) =>
      transaction
        .update(schema.supportRequests)
        .set({ status: "IN_PROGRESS" })
        .where(eq(schema.supportRequests.id, requestId))
        .returning({ status: schema.supportRequests.status }),
    );
    expect(updated).toEqual([{ status: "IN_PROGRESS" }]);

    const internalNote = await asApplicationUser(supportUserId, (transaction) =>
      transaction
        .insert(schema.supportMessages)
        .values({
          organizationId,
          requestId,
          authorUserId: supportUserId,
          visibility: "INTERNAL",
          body: "Internal note added by assigned staff",
        })
        .returning(),
    );
    expect(internalNote).toHaveLength(1);
    const customerMessages = await asApplicationUser(
      customerId,
      (transaction) => transaction.select().from(schema.supportMessages),
    );
    expect(customerMessages.map(({ visibility }) => visibility)).toEqual([
      "CUSTOMER",
    ]);

    await expect(
      asApplicationUser(customerId, (transaction) =>
        transaction
          .insert(schema.supportMessages)
          .values({
            organizationId,
            requestId,
            authorUserId: customerId,
            visibility: "INTERNAL",
            body: "Forged internal note",
          })
          .returning(),
      ),
    ).rejects.toThrow();
  });

  it("limits support staff to assigned requests with an active organization grant", async () => {
    const visibleRequests = await asApplicationUser(
      supportUserId,
      (transaction) => transaction.select().from(schema.supportRequests),
    );
    const visibleMessages = await asApplicationUser(
      supportUserId,
      (transaction) => transaction.select().from(schema.supportMessages),
    );
    const visibleOrganizations = await asApplicationUser(
      supportUserId,
      (transaction) =>
        transaction
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, organizationId)),
    );

    expect(visibleRequests.map(({ id }) => id)).toEqual([requestId]);
    expect(visibleMessages.map(({ body }) => body)).toEqual(
      expect.arrayContaining(["Customer-visible reply", "Staff-only note"]),
    );
    expect(visibleMessages).toHaveLength(3);
    expect(visibleOrganizations).toHaveLength(1);
  });

  it("denies access immediately after a grant expires or is revoked", async () => {
    await database
      .update(schema.supportAccessGrants)
      .set({ expiresAt: new Date(Date.now() + 100) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expired = await asApplicationUser(supportUserId, (transaction) =>
      transaction.select().from(schema.supportRequests),
    );
    expect(expired).toEqual([]);

    await database.update(schema.supportAccessGrants).set({
      expiresAt: new Date(Date.now() + 60 * 60_000),
      revokedAt: new Date(),
    });
    const revoked = await asApplicationUser(supportUserId, (transaction) =>
      transaction.select().from(schema.supportRequests),
    );
    expect(revoked).toEqual([]);
  });
});
