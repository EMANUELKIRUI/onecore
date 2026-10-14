import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@onecore/config";
import type {
  Database,
  IdentitySession,
  IdentityUser,
} from "@onecore/database";
import * as schema from "@onecore/database";
import { buildApp } from "../src/app.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);
const now = () => new Date();

let client: PGlite;
let database: PgliteDatabase;
let appDatabase: Database;
let identity: MemoryIdentityRepository;
let app: ReturnType<typeof buildApp>;
let rootId: string;
let subordinateId: string;
let supportId: string;
let customerId: string;
let otherCustomerId: string;
let organizationId: string;
let otherOrganizationId: string;
let requestId: string;
let otherRequestId: string;
let rollbackRequestId: string;
let grantId: string;
let sessions: Record<
  "root" | "subordinate" | "support" | "customer" | "otherCustomer",
  string
>;

async function applyMigrations(): Promise<void> {
  const directories = await readdir(migrationsDirectory, {
    withFileTypes: true,
  });
  for (const name of directories
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const source = await readFile(
      join(migrationsDirectory, name, "migration.sql"),
      "utf8",
    );
    for (const statement of source
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean)) {
      await client.exec("BEGIN");
      try {
        await client.exec(statement);
        await client.exec("COMMIT");
      } catch (error) {
        await client.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

function appRoleDatabase(rootDatabase: PgliteDatabase): Database {
  return new Proxy(rootDatabase, {
    get(target, property) {
      if (property === "transaction") {
        return (callback: (transaction: unknown) => Promise<unknown>) =>
          target.transaction(async (transaction) => {
            await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
            return callback(transaction);
          });
      }
      return Reflect.get(target, property, target);
    },
  }) as unknown as Database;
}

function addAuthenticatedUser(
  name: string,
  options: {
    userId: string;
    organizationId?: string | null;
    role?: string;
    mfaVerified?: boolean;
  },
): string {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const user: IdentityUser = {
    id: options.userId,
    email: `${name}-${options.userId}@example.test`,
    displayName: name,
    status: "ACTIVE",
    passwordHash: null,
    failedLoginAttempts: 0,
    failedLoginWindowStartedAt: null,
    lockedUntil: null,
    lastLoginAt: null,
  };
  identity.addUser(user);
  if (options.role) identity.addPlatformRole(options.userId, options.role);
  const session: IdentitySession = {
    id: crypto.randomUUID(),
    secretHash,
    userId: options.userId,
    organizationId: options.organizationId ?? null,
    branchId: null,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    mfaVerifiedAt: options.mfaVerified ? now() : null,
    lastUsedAt: now(),
    revokedAt: null,
    ipAddress: null,
    userAgent: null,
  };
  identity.sessions.set(secretHash, session);
  return secret;
}

function authCookies(secret?: string): Record<string, string> {
  return secret ? { onecore_session: secret } : {};
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle({ client });
  await client.exec(`
    CREATE ROLE onecore_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE onecore_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  `);
  await applyMigrations();

  rootId = crypto.randomUUID();
  subordinateId = crypto.randomUUID();
  supportId = crypto.randomUUID();
  customerId = crypto.randomUUID();
  otherCustomerId = crypto.randomUUID();
  organizationId = crypto.randomUUID();
  otherOrganizationId = crypto.randomUUID();
  requestId = crypto.randomUUID();
  otherRequestId = crypto.randomUUID();
  rollbackRequestId = crypto.randomUUID();

  await database.insert(schema.organizations).values([
    {
      id: organizationId,
      name: "Support API Tenant A",
      slug: `support-api-${organizationId.slice(0, 8)}`,
      industry: "TEST",
      status: "ACTIVE",
    },
    {
      id: otherOrganizationId,
      name: "Support API Tenant B",
      slug: `support-api-${otherOrganizationId.slice(0, 8)}`,
      industry: "TEST",
      status: "ACTIVE",
    },
  ]);
  await database.insert(schema.users).values(
    [rootId, subordinateId, supportId, customerId, otherCustomerId].map(
      (id) => ({
        id,
        email: `support-api-${id}@example.test`,
        displayName: "Support API test identity",
        status: "ACTIVE" as const,
      }),
    ),
  );
  await database.insert(schema.organizationMemberships).values([
    { organizationId, userId: customerId, status: "ACTIVE" },
    {
      organizationId: otherOrganizationId,
      userId: otherCustomerId,
      status: "ACTIVE",
    },
  ]);
  await database.insert(schema.platformUserRoles).values([
    { userId: rootId, role: "SUPERADMIN" },
    { userId: subordinateId, role: "SUPERADMIN" },
    { userId: supportId, role: "SUPPORT" },
  ]);
  await database.insert(schema.supportRootAdministrators).values({
    userId: rootId,
  });

  const [grant] = await database
    .insert(schema.supportAccessGrants)
    .values({
      organizationId,
      supportUserId: supportId,
      grantedByUserId: rootId,
      reason: "Disposable Support API security fixture",
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  if (!grant) throw new Error("Support API grant fixture was not created");
  grantId = grant.id;
  await database.insert(schema.supportRequests).values([
    {
      id: requestId,
      organizationId,
      createdByUserId: customerId,
      assignedSupportUserId: supportId,
      subject: "Tenant A support request",
    },
    {
      id: otherRequestId,
      organizationId: otherOrganizationId,
      createdByUserId: otherCustomerId,
      assignedSupportUserId: supportId,
      subject: "Tenant B support request",
    },
    {
      id: rollbackRequestId,
      organizationId,
      createdByUserId: customerId,
      subject: "Assignment rollback request",
    },
  ]);
  await database.insert(schema.supportMessages).values([
    {
      organizationId,
      requestId,
      authorUserId: customerId,
      visibility: "CUSTOMER",
      body: "Customer-visible message",
    },
    {
      organizationId,
      requestId,
      authorUserId: supportId,
      visibility: "INTERNAL",
      body: "Do not disclose this internal note",
    },
  ]);

  identity = new MemoryIdentityRepository();
  sessions = {
    root: addAuthenticatedUser("root", {
      userId: rootId,
      role: "SUPERADMIN",
      mfaVerified: true,
    }),
    subordinate: addAuthenticatedUser("subordinate", {
      userId: subordinateId,
      role: "SUPERADMIN",
      mfaVerified: true,
    }),
    support: addAuthenticatedUser("support", {
      userId: supportId,
      role: "SUPPORT",
      mfaVerified: true,
    }),
    customer: addAuthenticatedUser("customer", {
      userId: customerId,
      organizationId,
    }),
    otherCustomer: addAuthenticatedUser("other-customer", {
      userId: otherCustomerId,
      organizationId: otherOrganizationId,
    }),
  };
  identity.addMembership(customerId, {
    organizationId,
    name: "Support API Tenant A",
    slug: "support-api-tenant-a",
  });
  identity.addMembership(otherCustomerId, {
    organizationId: otherOrganizationId,
    name: "Support API Tenant B",
    slug: "support-api-tenant-b",
  });

  appDatabase = appRoleDatabase(database);
  app = buildApp(
    loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    identity,
    undefined,
    { database: appDatabase },
  );
}, 30_000);

afterAll(async () => {
  await app?.close();
  await client?.close();
});

describe("Support API security", () => {
  it("requires authentication on every protected Support and platform route", async () => {
    const requests = [
      ["GET", "/support/requests"],
      ["POST", "/support/requests"],
      ["GET", `/support/requests/${requestId}`],
      ["PATCH", `/support/requests/${requestId}`],
      ["POST", `/support/requests/${requestId}/messages`],
      ["POST", `/support/requests/${requestId}/notes`],
      ["POST", `/platform/support/requests/${requestId}/assignment`],
      ["POST", "/platform/support/staff"],
      ["DELETE", `/platform/support/staff/${supportId}`],
      ["POST", `/platform/support/organizations/${organizationId}/grants`],
      ["DELETE", `/platform/support/grants/${grantId}`],
    ] as const;
    for (const [method, url] of requests) {
      const response = await app.inject({
        method,
        url,
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("confines organization members to their tenant and rejects forged IDs", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/support/requests",
      cookies: authCookies(sessions.customer),
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().requests.map((request: { id: string }) => request.id),
    ).toEqual(expect.arrayContaining([requestId, rollbackRequestId]));
    expect(list.json().requests).toHaveLength(2);
    expect(list.body).not.toContain(otherRequestId);

    const ownDetails = await app.inject({
      method: "GET",
      url: `/support/requests/${requestId}`,
      cookies: authCookies(sessions.customer),
    });
    expect(ownDetails.statusCode).toBe(200);
    const foreignDetails = await app.inject({
      method: "GET",
      url: `/support/requests/${otherRequestId}`,
      cookies: authCookies(sessions.customer),
    });
    expect(foreignDetails.statusCode).toBe(404);
    const deniedLookupAudit = await database
      .select({
        action: schema.auditLogs.action,
        result: schema.auditLogs.result,
      })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resource, "authentication"),
          eq(schema.auditLogs.action, "SUPPORT_REQUEST_ACCESS_DENIED"),
          eq(schema.auditLogs.resourceId, otherRequestId),
          eq(schema.auditLogs.actorUserId, customerId),
        ),
      );
    expect(deniedLookupAudit).toEqual([
      { action: "SUPPORT_REQUEST_ACCESS_DENIED", result: "FAILURE" },
    ]);
    const unknownRequest = await app.inject({
      method: "GET",
      url: `/support/requests/${crypto.randomUUID()}`,
      cookies: authCookies(sessions.customer),
    });
    expect(unknownRequest.statusCode).toBe(404);

    const forgedOrganization = await app.inject({
      method: "POST",
      url: "/support/requests",
      cookies: authCookies(sessions.customer),
      payload: {
        organizationId: otherOrganizationId,
        subject: "Forged organization",
        body: "Should not create",
      },
    });
    expect(forgedOrganization.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/support/requests",
      cookies: authCookies(sessions.customer),
      payload: {
        subject: "Customer-owned request",
        body: "Created only in the session tenant",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().request.organizationId).toBe(organizationId);

    const forgedReply = await app.inject({
      method: "POST",
      url: `/support/requests/${otherRequestId}/messages`,
      cookies: authCookies(sessions.customer),
      payload: { body: "Cross-tenant reply" },
    });
    expect(forgedReply.statusCode).toBe(404);
    const forgedUpdate = await app.inject({
      method: "PATCH",
      url: `/support/requests/${otherRequestId}`,
      cookies: authCookies(sessions.customer),
      payload: { status: "CLOSED" },
    });
    expect(forgedUpdate.statusCode).toBe(403);
    const forgedAssignment = await app.inject({
      method: "POST",
      url: `/platform/support/requests/${requestId}/assignment`,
      cookies: authCookies(sessions.customer),
      payload: { supportUserId: otherCustomerId },
    });
    expect(forgedAssignment.statusCode).toBe(403);
    const unsupportedAssignee = await app.inject({
      method: "POST",
      url: `/platform/support/requests/${rollbackRequestId}/assignment`,
      cookies: authCookies(sessions.root),
      payload: { supportUserId: otherCustomerId },
    });
    expect(unsupportedAssignee.statusCode).toBe(404);
  });

  it("does not treat Support or subordinate Superadmin membership as Root access", async () => {
    const supportQueue = await app.inject({
      method: "GET",
      url: "/support/requests",
      cookies: authCookies(sessions.support),
    });
    expect(supportQueue.statusCode).toBe(200);
    expect(
      supportQueue.json().requests.map((request: { id: string }) => request.id),
    ).toEqual([requestId]);
    const ungrantedForeignRequest = await app.inject({
      method: "GET",
      url: `/support/requests/${otherRequestId}`,
      cookies: authCookies(sessions.support),
    });
    expect(ungrantedForeignRequest.statusCode).toBe(404);

    const unsupportedStaff = crypto.randomUUID();
    const ordinary = sessions.customer;
    const subordinateOnly = sessions.subordinate;
    for (const secret of [ordinary, subordinateOnly]) {
      const manageStaff = await app.inject({
        method: "POST",
        url: "/platform/support/staff",
        cookies: authCookies(secret),
        payload: { userId: unsupportedStaff },
      });
      expect(manageStaff.statusCode).toBe(403);
      const disableStaff = await app.inject({
        method: "DELETE",
        url: `/platform/support/staff/${supportId}`,
        cookies: authCookies(secret),
      });
      expect(disableStaff.statusCode).toBe(403);
      const grant = await app.inject({
        method: "POST",
        url: `/platform/support/organizations/${organizationId}/grants`,
        cookies: authCookies(secret),
        payload: {
          supportUserId: supportId,
          reason: "Unauthorized grant attempt",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect(grant.statusCode).toBe(403);
      const revoke = await app.inject({
        method: "DELETE",
        url: `/platform/support/grants/${grantId}`,
        cookies: authCookies(secret),
      });
      expect(revoke.statusCode).toBe(403);
      const assign = await app.inject({
        method: "POST",
        url: `/platform/support/requests/${requestId}/assignment`,
        cookies: authCookies(secret),
        payload: { supportUserId: supportId },
      });
      expect(assign.statusCode).toBe(403);
    }
    const forbiddenRole = await database
      .select()
      .from(schema.platformUserRoles)
      .where(
        and(
          eq(schema.platformUserRoles.userId, unsupportedStaff),
          eq(schema.platformUserRoles.role, "SUPPORT"),
        ),
      );
    expect(forbiddenRole).toHaveLength(0);
  });

  it("requires MFA for Support and Root operations even with an otherwise active session", async () => {
    const supportNoMfa = addAuthenticatedUser("support-no-mfa", {
      userId: supportId,
      role: "SUPPORT",
    });
    const rootNoMfa = addAuthenticatedUser("root-no-mfa", {
      userId: rootId,
      role: "SUPERADMIN",
    });
    const staffRead = await app.inject({
      method: "GET",
      url: "/support/requests",
      cookies: authCookies(supportNoMfa),
    });
    expect(staffRead.statusCode).toBe(401);
    const rootGrant = await app.inject({
      method: "DELETE",
      url: `/platform/support/grants/${grantId}`,
      cookies: authCookies(rootNoMfa),
    });
    expect(rootGrant.statusCode).toBe(401);
  });

  it("hides internal notes from all customer response and error paths", async () => {
    const customerList = await app.inject({
      method: "GET",
      url: "/support/requests",
      cookies: authCookies(sessions.customer),
    });
    const customerDetail = await app.inject({
      method: "GET",
      url: `/support/requests/${requestId}`,
      cookies: authCookies(sessions.customer),
    });
    const customerReply = await app.inject({
      method: "POST",
      url: `/support/requests/${requestId}/messages`,
      cookies: authCookies(sessions.customer),
      payload: { body: "Customer follow-up" },
    });
    const forbiddenNote = await app.inject({
      method: "POST",
      url: `/support/requests/${requestId}/notes`,
      cookies: authCookies(sessions.customer),
      payload: { body: "Forged internal note" },
    });
    expect(customerList.statusCode).toBe(200);
    expect(customerDetail.statusCode).toBe(200);
    expect(customerReply.statusCode).toBe(201);
    expect(forbiddenNote.statusCode).toBe(403);
    for (const response of [
      customerList,
      customerDetail,
      customerReply,
      forbiddenNote,
    ]) {
      expect(response.body).not.toContain("Do not disclose this internal note");
    }
    expect(customerList.body).not.toContain("messages");
    expect(
      customerDetail
        .json()
        .messages.map((message: { visibility: string }) => message.visibility),
    ).toEqual(["CUSTOMER"]);

    const requestErrors = await app.inject({
      method: "GET",
      url: `/support/requests/${otherRequestId}`,
      cookies: authCookies(sessions.customer),
    });
    expect(requestErrors.statusCode).toBe(404);
    expect(requestErrors.body).not.toContain(
      "Do not disclose this internal note",
    );
  });

  it("audits authorized assignments, status changes, grants, revocation, and sensitive reads", async () => {
    const assign = await app.inject({
      method: "POST",
      url: `/platform/support/requests/${requestId}/assignment`,
      cookies: authCookies(sessions.root),
      payload: { supportUserId: supportId },
    });
    expect(assign.statusCode).toBe(200);
    const update = await app.inject({
      method: "PATCH",
      url: `/support/requests/${requestId}`,
      cookies: authCookies(sessions.support),
      payload: { status: "IN_PROGRESS" },
    });
    expect(update.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/support/requests/${requestId}`,
      cookies: authCookies(sessions.support),
    });
    expect(detail.statusCode).toBe(200);

    const createdGrant = await app.inject({
      method: "POST",
      url: `/platform/support/organizations/${otherOrganizationId}/grants`,
      cookies: authCookies(sessions.root),
      payload: {
        supportUserId: supportId,
        reason: "Security test scoped grant",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    });
    expect(createdGrant.statusCode).toBe(201);
    const revoke = await app.inject({
      method: "DELETE",
      url: `/platform/support/grants/${createdGrant.json().grant.id}`,
      cookies: authCookies(sessions.root),
    });
    expect(revoke.statusCode).toBe(204);

    const actions = await database
      .select({
        action: schema.auditLogs.action,
        resourceId: schema.auditLogs.resourceId,
      })
      .from(schema.auditLogs)
      .where(
        sql`${schema.auditLogs.resource} = 'support' AND ${schema.auditLogs.resourceId} IN (${requestId}, ${createdGrant.json().grant.id})`,
      );
    expect(actions.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "SUPPORT_REQUEST_ASSIGNED",
        "SUPPORT_REQUEST_UPDATED",
        "SUPPORT_REQUEST_VIEWED",
        "SUPPORT_ORGANIZATION_ACCESS_GRANTED",
        "SUPPORT_ORGANIZATION_ACCESS_REVOKED",
      ]),
    );
  });

  it("enforces grant expiry/revocation immediately and rolls back failed audited mutations", async () => {
    const expiryResult = await database
      .update(schema.supportAccessGrants)
      .set({
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 24 * 60 * 60_000),
      })
      .where(eq(schema.supportAccessGrants.id, grantId))
      .returning();
    expect(expiryResult).toHaveLength(1);
    const expiredRead = await app.inject({
      method: "GET",
      url: `/support/requests/${requestId}`,
      cookies: authCookies(sessions.support),
    });
    const expiredReply = await app.inject({
      method: "POST",
      url: `/support/requests/${requestId}/messages`,
      cookies: authCookies(sessions.support),
      payload: { body: "Expired grant reply" },
    });
    const expiredUpdate = await app.inject({
      method: "PATCH",
      url: `/support/requests/${requestId}`,
      cookies: authCookies(sessions.support),
      payload: { status: "CLOSED" },
    });
    expect(expiredRead.statusCode).toBe(404);
    expect(expiredReply.statusCode).toBe(404);
    expect(expiredUpdate.statusCode).toBe(404);

    await database
      .update(schema.supportAccessGrants)
      .set({
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        revokedAt: null,
      })
      .where(eq(schema.supportAccessGrants.id, grantId));
    const revoked = await app.inject({
      method: "DELETE",
      url: `/platform/support/grants/${grantId}`,
      cookies: authCookies(sessions.root),
    });
    expect(revoked.statusCode).toBe(204);
    const revokedReply = await app.inject({
      method: "POST",
      url: `/support/requests/${requestId}/messages`,
      cookies: authCookies(sessions.support),
      payload: { body: "Revoked grant reply" },
    });
    const revokedUpdate = await app.inject({
      method: "PATCH",
      url: `/support/requests/${requestId}`,
      cookies: authCookies(sessions.support),
      payload: { status: "CLOSED" },
    });
    const revokedNote = await app.inject({
      method: "POST",
      url: `/support/requests/${requestId}/notes`,
      cookies: authCookies(sessions.support),
      payload: { body: "Revoked grant internal note" },
    });
    expect(revokedReply.statusCode).toBe(404);
    expect(revokedUpdate.statusCode).toBe(404);
    expect(revokedNote.statusCode).toBe(404);

    await database
      .update(schema.supportAccessGrants)
      .set({
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        revokedAt: null,
      })
      .where(eq(schema.supportAccessGrants.id, grantId));
    await client.exec(`
      CREATE FUNCTION fail_support_assignment_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'SUPPORT_REQUEST_ASSIGNED' THEN
          RAISE EXCEPTION 'synthetic audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_support_assignment_audit_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION fail_support_assignment_audit();
    `);
    const before = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resource, "support"),
          eq(schema.auditLogs.action, "SUPPORT_REQUEST_ASSIGNED"),
          eq(schema.auditLogs.resourceId, rollbackRequestId),
        ),
      );
    const failedAssignment = await app.inject({
      method: "POST",
      url: `/platform/support/requests/${rollbackRequestId}/assignment`,
      cookies: authCookies(sessions.root),
      payload: { supportUserId: supportId },
    });
    expect(failedAssignment.statusCode).toBe(500);
    await client.exec(
      "DROP TRIGGER fail_support_assignment_audit_trigger ON audit_logs; DROP FUNCTION fail_support_assignment_audit()",
    );
    const [afterRequest] = await database
      .select({
        assignedSupportUserId: schema.supportRequests.assignedSupportUserId,
      })
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.id, rollbackRequestId));
    const after = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resource, "support"),
          eq(schema.auditLogs.action, "SUPPORT_REQUEST_ASSIGNED"),
          eq(schema.auditLogs.resourceId, rollbackRequestId),
        ),
      );
    expect(afterRequest?.assignedSupportUserId).toBeNull();
    expect(after).toHaveLength(before.length);
  });
});
