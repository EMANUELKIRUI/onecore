import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  OrganizationTransaction,
  ResolvedAuthorizationContext,
} from "@onecore/database";
import { loadConfig } from "@onecore/config";
import * as schema from "@onecore/database";
import { buildApp } from "../src/app.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);
let client: PGlite;
let database: PgliteDatabase;

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

const permissionKeys = [
  "core.organization.user.read",
  "core.organization.user.update",
  "core.organization.branch.read",
  "core.organization.branch.create",
  "core.organization.branch.update",
  "core.business_manager.customer.create",
  "core.business_manager.customer.read",
  "core.business_manager.customer.update",
  "core.business_manager.customer.delete",
  "core.business_manager.catalog.create",
  "core.business_manager.catalog.read",
  "core.business_manager.catalog.update",
  "core.business_manager.catalog.delete",
] as const;

function allowBusinessManager(): AuthorizationService {
  async function withPermission<T>(
    requestContext: AuthorizationContext | null,
    permissionKey: string,
    _metadata: AuthorizationMetadata,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>> {
    if (!requestContext?.organizationId || !requestContext.membershipId) {
      return {
        allowed: false,
        statusCode: requestContext ? 403 : 401,
        dataScopes: [],
      };
    }
    if (!permissionKeys.some((key) => key === permissionKey)) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }
    const context: ResolvedAuthorizationContext = {
      userId: requestContext.userId,
      sessionId: requestContext.sessionId,
      organizationId: requestContext.organizationId,
      membershipId: requestContext.membershipId,
      branchId: requestContext.branchId,
      branch: null,
      branchAccessMode: "ALL",
      roles: [],
      platformRoles: [],
      permissions: permissionKeys.map((key) => ({
        key,
        moduleKey: key.startsWith("core.organization.")
          ? "core.organization"
          : "core.business_manager",
        scopeType: "ORGANIZATION",
        scope: {},
      })),
    };
    const value = await database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
      await transaction.execute(
        sql`SELECT set_config('app.current_user_id', ${context.userId}, true)`,
      );
      await transaction.execute(
        sql`SELECT set_config('app.current_organization_id', ${context.organizationId}, true)`,
      );
      return operation(
        transaction as unknown as OrganizationTransaction,
        context,
      );
    });
    return { allowed: true, value, context };
  }

  return {
    authorize: async (context) =>
      context
        ? { allowed: true, statusCode: 200, dataScopes: ["ORGANIZATION"] }
        : { allowed: false, statusCode: 401, dataScopes: [] },
    hasPermission: async (context) => context !== null,
    withPermission,
    withAllPermissions: async (context, keys, metadata, operation) =>
      withPermission(context, keys[0] ?? "", metadata, operation),
    withAnyPermission: async (context, keys, metadata, operation) =>
      withPermission(context, keys[0] ?? "", metadata, operation),
  };
}

describe("Business Manager API", () => {
  beforeAll(async () => {
    client = new PGlite();
    database = drizzle({ client });
    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    `);
    await applyMigrations();
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("authenticates, validates, and provides customer and catalog CRUD", async () => {
    const tenant = await database
      .insert(schema.organizations)
      .values({
        name: "API Business",
        slug: `api-business-${crypto.randomUUID()}`,
        industry: "TEST",
        status: "ACTIVE",
      })
      .returning();
    const userRows = await database
      .insert(schema.users)
      .values({
        email: "business-api@onecore.test",
        displayName: "Business API User",
      })
      .returning();
    const organization = tenant[0];
    const user = userRows[0];
    if (!organization || !user) throw new Error("API fixture not created");

    const userId = user.id;
    const organizationId = organization.id;
    const sessionSecret = "b".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: userId,
      email: user.email,
      displayName: user.displayName,
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(userId, {
      organizationId,
      name: organization.name,
      slug: organization.slug,
      branchAccessMode: "ALL",
    });
    identity.sessions.set(secretHash, {
      id: crypto.randomUUID(),
      secretHash,
      userId,
      organizationId,
      branchId: null,
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: new Date(),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(),
    );

    const foreignBranchFilter = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/business/customers?branchId=${crypto.randomUUID()}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(foreignBranchFilter.statusCode).toBe(403);
    const foreignBranchCreate = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/business/catalog`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        branchId: crypto.randomUUID(),
        name: "Unauthorized branch",
        type: "PRODUCT",
        unit: "each",
        price: "5",
        currency: "KES",
      },
    });
    expect(foreignBranchCreate.statusCode).toBe(403);

    const anonymous = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/business/customers`,
    });
    expect(anonymous.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/business/customers`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Invalid customer", customerType: "LEAD" },
    });
    expect(invalid.statusCode).toBe(400);

    const createdBranch = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/branches`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Nairobi HQ", code: "hq", address: "Nairobi, Kenya" },
    });
    expect(createdBranch.statusCode).toBe(201);
    expect(createdBranch.json().branch).toMatchObject({
      name: "Nairobi HQ",
      code: "HQ",
      status: "ACTIVE",
      address: "Nairobi, Kenya",
    });
    const branchId = createdBranch.json().branch.id as string;
    const listedBranches = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/branches?limit=1&offset=0`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(listedBranches.statusCode).toBe(200);
    expect(listedBranches.json()).toMatchObject({
      total: 1,
      limit: 1,
      items: [{ id: branchId, name: "Nairobi HQ", code: "HQ" }],
    });
    const duplicateBranch = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/branches`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Duplicate", code: "HQ" },
    });
    expect(duplicateBranch.statusCode).toBe(409);
    const deactivatedBranch = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/branches/${branchId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Nairobi Main", status: "INACTIVE" },
    });
    expect(deactivatedBranch.statusCode).toBe(200);
    expect(deactivatedBranch.json().branch).toMatchObject({
      name: "Nairobi Main",
      status: "INACTIVE",
    });
    const reactivatedBranch = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/branches/${branchId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { status: "ACTIVE" },
    });
    expect(reactivatedBranch.statusCode).toBe(200);
    expect(reactivatedBranch.json().branch.status).toBe("ACTIVE");

    const secondBranch = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/branches`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Mombasa Office", code: "MBA" },
    });
    expect(secondBranch.statusCode).toBe(201);
    const secondBranchId = secondBranch.json().branch.id as string;

    const assignmentUserRows = await database
      .insert(schema.users)
      .values({
        email: "branch-assignment@onecore.test",
        displayName: "Branch Assignment Target",
        status: "ACTIVE",
      })
      .returning();
    const assignmentUser = assignmentUserRows[0];
    if (!assignmentUser) throw new Error("Assignment user fixture missing");
    const assignmentMembershipRows = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId,
        userId: assignmentUser.id,
        status: "ACTIVE",
        branchAccessMode: "ASSIGNED",
      })
      .returning();
    const assignmentMembership = assignmentMembershipRows[0];
    if (!assignmentMembership)
      throw new Error("Assignment membership fixture missing");
    const assignmentsPath = `/organizations/${organizationId}/members/${assignmentMembership.id}/branches`;
    const initialAssignments = await app.inject({
      method: "GET",
      url: assignmentsPath,
      cookies: { onecore_session: sessionSecret },
    });
    expect(initialAssignments.statusCode).toBe(200);
    expect(initialAssignments.json()).toEqual({
      membershipId: assignmentMembership.id,
      branchAccessMode: "ASSIGNED",
      assignedBranches: [],
    });
    expect(initialAssignments.json()).not.toHaveProperty("userId");
    const createdAssignments = await app.inject({
      method: "POST",
      url: assignmentsPath,
      cookies: { onecore_session: sessionSecret },
      payload: { branchIds: [branchId, secondBranchId] },
    });
    expect(createdAssignments.statusCode).toBe(200);
    expect(createdAssignments.json().assignedBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branchId }),
        expect.objectContaining({ branchId: secondBranchId }),
      ]),
    );
    const repeatedAssignment = await app.inject({
      method: "POST",
      url: assignmentsPath,
      cookies: { onecore_session: sessionSecret },
      payload: { branchIds: [branchId] },
    });
    expect(repeatedAssignment.statusCode).toBe(200);
    expect(repeatedAssignment.json().assignedBranches).toHaveLength(2);
    const foreignBranchAssignment = await app.inject({
      method: "POST",
      url: assignmentsPath,
      cookies: { onecore_session: sessionSecret },
      payload: { branchIds: [crypto.randomUUID()] },
    });
    expect(foreignBranchAssignment.statusCode).toBe(404);
    const removedAssignment = await app.inject({
      method: "DELETE",
      url: `${assignmentsPath}/${branchId}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(removedAssignment.statusCode).toBe(200);
    const remainingAssignments = await app.inject({
      method: "GET",
      url: assignmentsPath,
      cookies: { onecore_session: sessionSecret },
    });
    expect(remainingAssignments.json().assignedBranches).toEqual([
      expect.objectContaining({ branchId: secondBranchId }),
    ]);

    const allAccessUserRows = await database
      .insert(schema.users)
      .values({
        email: "branch-all-access@onecore.test",
        displayName: "All Branch Access Target",
        status: "ACTIVE",
      })
      .returning();
    const allAccessUser = allAccessUserRows[0];
    if (!allAccessUser) throw new Error("ALL access user fixture missing");
    const allAccessMembershipRows = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId,
        userId: allAccessUser.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      })
      .returning();
    const allAccessMembership = allAccessMembershipRows[0];
    if (!allAccessMembership)
      throw new Error("ALL access membership fixture missing");
    const allAccessPath = `/organizations/${organizationId}/members/${allAccessMembership.id}/branches`;
    const allAccessAssignment = await app.inject({
      method: "POST",
      url: allAccessPath,
      cookies: { onecore_session: sessionSecret },
      payload: { branchIds: [branchId] },
    });
    expect(allAccessAssignment.statusCode).toBe(409);
    const allAccessRemoval = await app.inject({
      method: "DELETE",
      url: `${allAccessPath}/${branchId}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(allAccessRemoval.statusCode).toBe(409);

    const otherOrganizationRows = await database
      .insert(schema.organizations)
      .values({
        name: "Other Assignment Tenant",
        slug: `other-assignment-${crypto.randomUUID()}`,
        industry: "TEST",
        status: "ACTIVE",
      })
      .returning();
    const otherOrganization = otherOrganizationRows[0];
    if (!otherOrganization)
      throw new Error("Other organization fixture missing");
    const otherUserRows = await database
      .insert(schema.users)
      .values({
        email: "other-assignment@onecore.test",
        displayName: "Other Tenant Member",
        status: "ACTIVE",
      })
      .returning();
    const otherUser = otherUserRows[0];
    if (!otherUser) throw new Error("Other user fixture missing");
    const otherMembershipRows = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: otherOrganization.id,
        userId: otherUser.id,
        status: "ACTIVE",
        branchAccessMode: "ASSIGNED",
      })
      .returning();
    const otherMembership = otherMembershipRows[0];
    if (!otherMembership) throw new Error("Other membership fixture missing");
    const mismatchedMembership = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/members/${otherMembership.id}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(mismatchedMembership.statusCode).toBe(404);
    const mismatchedOrganization = await app.inject({
      method: "GET",
      url: `/organizations/${otherOrganization.id}/members/${assignmentMembership.id}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(mismatchedOrganization.statusCode).toBe(404);
    const ownMembershipId = identity.memberships.get(userId)?.[0]?.membershipId;
    if (!ownMembershipId) throw new Error("Actor membership fixture missing");
    const selfAssignment = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/members/${ownMembershipId}/branches`,
      cookies: { onecore_session: sessionSecret },
      payload: { branchIds: [branchId] },
    });
    expect(selfAssignment.statusCode).toBe(403);

    const customerResponse = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/business/customers`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        reference: "cust-1",
        name: "Acme",
        customerType: "BUSINESS",
        email: "SALES@ACME.EXAMPLE",
      },
    });
    expect(customerResponse.statusCode).toBe(201);
    expect(customerResponse.json().customer).toMatchObject({
      reference: "CUST-1",
      name: "Acme",
      email: "sales@acme.example",
      status: "ACTIVE",
    });
    const customerId = customerResponse.json().customer.id as string;

    const duplicateReference = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/business/customers`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        reference: "CUST-1",
        name: "Duplicate",
        customerType: "BUSINESS",
      },
    });
    expect(duplicateReference.statusCode).toBe(409);

    const listedCustomers = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/business/customers?search=acme&limit=10`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(listedCustomers.statusCode).toBe(200);
    expect(listedCustomers.json()).toMatchObject({
      total: 1,
      limit: 10,
      items: [{ id: customerId }],
    });
    const readCustomer = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/business/customers/${customerId}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(readCustomer.statusCode).toBe(200);
    const updatedCustomer = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/business/customers/${customerId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Acme Updated" },
    });
    expect(updatedCustomer.statusCode).toBe(200);
    expect(updatedCustomer.json().customer.name).toBe("Acme Updated");
    const deletedCustomer = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/business/customers/${customerId}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(deletedCustomer.statusCode).toBe(200);
    expect(deletedCustomer.json().customer.status).toBe("INACTIVE");

    const itemResponse = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/business/catalog`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        reference: "svc-1",
        name: "Consulting",
        type: "SERVICE",
        unit: "hour",
        price: "0.100001",
        currency: "KES",
      },
    });
    expect(itemResponse.statusCode).toBe(201);
    expect(itemResponse.json().item.price).toBe("0.100001");
    const itemId = itemResponse.json().item.id as string;

    const catalogList = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/business/catalog?type=SERVICE`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(catalogList.statusCode).toBe(200);
    expect(catalogList.json()).toMatchObject({
      total: 1,
      items: [{ id: itemId, type: "SERVICE" }],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/organizations/${organizationId}/business/catalog/${itemId}`,
          cookies: { onecore_session: sessionSecret },
        })
      ).statusCode,
    ).toBe(200);
    const updatedItem = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/business/catalog/${itemId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { price: "12.5" },
    });
    expect(updatedItem.statusCode).toBe(200);
    expect(updatedItem.json().item.price).toBe("12.500000");
    const deletedItem = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/business/catalog/${itemId}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(deletedItem.statusCode).toBe(200);
    expect(deletedItem.json().item.status).toBe("INACTIVE");

    const outbox = await database
      .select({
        eventType: schema.outboxEvents.eventType,
        payload: schema.outboxEvents.payload,
      })
      .from(schema.outboxEvents)
      .where(sql`${schema.outboxEvents.organizationId} = ${organizationId}`);
    expect(outbox.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining([
        "CUSTOMER_CREATED",
        "CUSTOMER_UPDATED",
        "CUSTOMER_DELETED",
        "CATALOG_ITEM_CREATED",
        "CATALOG_ITEM_UPDATED",
        "CATALOG_ITEM_DELETED",
      ]),
    );
    expect(JSON.stringify(outbox)).not.toContain("sales@acme.example");
    const audits = await database
      .select({
        action: schema.auditLogs.action,
        requestMetadata: schema.auditLogs.requestMetadata,
      })
      .from(schema.auditLogs)
      .where(sql`${schema.auditLogs.organizationId} = ${organizationId}`);
    expect(JSON.stringify(audits)).not.toContain("sales@acme.example");
    expect(audits.length).toBeGreaterThanOrEqual(6);
    expect(audits.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "membership.branch.assigned",
        "membership.branch.unassigned",
        "authorization.membership_branch.denied",
      ]),
    );
    await app.close();
  });

  it("enforces route permission checks and hides other-organization routes", async () => {
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const otherOrganizationId = crypto.randomUUID();
    const sessionSecret = "c".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: userId,
      email: "denied-business@onecore.test",
      displayName: "Denied Business User",
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(userId, {
      organizationId,
      name: "Business",
      slug: "business",
    });
    identity.sessions.set(secretHash, {
      id: crypto.randomUUID(),
      secretHash,
      userId,
      organizationId,
      branchId: null,
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: new Date(),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
    );
    const denied = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/business/customers`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(denied.statusCode).toBe(403);
    const deniedBranchRead = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    const deniedBranchCreate = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/branches`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Restricted", code: "NOPE" },
    });
    const deniedBranchUpdate = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/branches/${crypto.randomUUID()}`,
      cookies: { onecore_session: sessionSecret },
      payload: { status: "INACTIVE" },
    });
    expect(deniedBranchRead.statusCode).toBe(403);
    expect(deniedBranchCreate.statusCode).toBe(403);
    expect(deniedBranchUpdate.statusCode).toBe(403);
    const deniedMembershipBranchRead = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/members/${crypto.randomUUID()}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    const deniedMembershipBranchAssign = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/members/${crypto.randomUUID()}/branches`,
      cookies: { onecore_session: sessionSecret },
      payload: { branchIds: [crypto.randomUUID()] },
    });
    const deniedMembershipBranchUnassign = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/members/${crypto.randomUUID()}/branches/${crypto.randomUUID()}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(deniedMembershipBranchRead.statusCode).toBe(403);
    expect(deniedMembershipBranchAssign.statusCode).toBe(403);
    expect(deniedMembershipBranchUnassign.statusCode).toBe(403);
    await app.close();

    const authorizedApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(),
    );
    const foreign = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${otherOrganizationId}/business/customers`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(foreign.statusCode).toBe(404);
    const foreignBranches = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${otherOrganizationId}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(foreignBranches.statusCode).toBe(404);
    const foreignMemberBranches = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${otherOrganizationId}/members/${crypto.randomUUID()}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(foreignMemberBranches.statusCode).toBe(404);
    await authorizedApp.close();
  });
});
