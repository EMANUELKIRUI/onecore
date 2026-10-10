import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
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
  "core.business_manager.customer.create",
  "core.business_manager.customer.read",
  "core.business_manager.customer.update",
  "core.business_manager.customer.delete",
  "core.business_manager.catalog.create",
  "core.business_manager.catalog.read",
  "core.business_manager.catalog.update",
  "core.business_manager.catalog.delete",
  "core.organization.settings.read",
  "core.organization.settings.update",
  "core.organization.user.read",
  "core.rbac.role.read",
  "core.rbac.membership_role.assign",
  "core.rbac.membership_role.remove",
  "core.organization.branch.read",
  "core.organization.branch.create",
  "core.organization.branch.update",
] as const;

function allowBusinessManager(
  permissions: readonly string[] = permissionKeys,
  scopeType: ResolvedAuthorizationContext["permissions"][number]["scopeType"] = "ORGANIZATION",
): AuthorizationService {
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
    if (!permissions.some((key) => key === permissionKey)) {
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
      permissions: permissions.map((key) => ({
        key,
        moduleKey: key.startsWith("core.organization.")
          ? "core.organization"
          : key.startsWith("core.rbac.")
            ? "core.rbac"
            : "core.business_manager",
        scopeType,
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
      CREATE ROLE onecore_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
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

    const profileUrl = `/organizations/${organizationId}/configuration`;
    const anonymousProfile = await app.inject({
      method: "GET",
      url: profileUrl,
    });
    expect(anonymousProfile.statusCode).toBe(401);

    const initialProfile = await app.inject({
      method: "GET",
      url: profileUrl,
      cookies: { onecore_session: sessionSecret },
    });
    expect(initialProfile.statusCode).toBe(200);
    expect(initialProfile.json().businessProfile).toEqual({
      contactEmail: null,
      contactPhone: null,
      website: null,
      countryCode: null,
      region: null,
      city: null,
      address: null,
    });

    const invalidProfile = await app.inject({
      method: "PATCH",
      url: profileUrl,
      cookies: { onecore_session: sessionSecret },
      payload: {
        businessProfile: {
          contactEmail: "not-an-email",
          address: "  ",
        },
      },
    });
    expect(invalidProfile.statusCode).toBe(400);

    const foreignProfile = await app.inject({
      method: "PATCH",
      url: `/organizations/${crypto.randomUUID()}/configuration`,
      cookies: { onecore_session: sessionSecret },
      payload: { businessProfile: { contactEmail: "owner@example.test" } },
    });
    expect(foreignProfile.statusCode).toBe(404);

    const savedProfile = await app.inject({
      method: "PATCH",
      url: profileUrl,
      cookies: { onecore_session: sessionSecret },
      payload: {
        businessProfile: {
          contactEmail: " SALES@ACME.EXAMPLE ",
          contactPhone: "+254700000000",
          website: "https://acme.example",
          countryCode: "KE",
          region: "Nairobi",
          city: "Nairobi",
          address: "Central Nairobi",
        },
      },
    });
    expect(savedProfile.statusCode).toBe(200);
    expect(savedProfile.json().business.contactEmail).toBe(
      "sales@acme.example",
    );
    const persistedProfile = await database
      .select({
        contactEmail: schema.businessSettings.contactEmail,
        contactPhone: schema.businessSettings.contactPhone,
        website: schema.businessSettings.website,
        addressCountryCode: schema.businessSettings.addressCountryCode,
        addressRegion: schema.businessSettings.addressRegion,
        addressCity: schema.businessSettings.addressCity,
        address: schema.businessSettings.address,
      })
      .from(schema.businessSettings)
      .where(
        sql`${schema.businessSettings.organizationId} = ${organizationId}`,
      );
    expect(persistedProfile[0]).toEqual({
      contactEmail: "sales@acme.example",
      contactPhone: "+254700000000",
      website: "https://acme.example",
      addressCountryCode: "KE",
      addressRegion: "Nairobi",
      addressCity: "Nairobi",
      address: "Central Nairobi",
    });
    const profileAudit = await database
      .select({
        action: schema.auditLogs.action,
        resource: schema.auditLogs.resource,
        resourceId: schema.auditLogs.resourceId,
      })
      .from(schema.auditLogs)
      .where(
        sql`${schema.auditLogs.organizationId} = ${organizationId} and ${schema.auditLogs.resource} = 'business_settings'`,
      );
    expect(profileAudit).toContainEqual({
      action: "CONFIGURATION_CREATED",
      resource: "business_settings",
      resourceId: organizationId,
    });
    const profileEvents = await database
      .select({
        eventType: schema.outboxEvents.eventType,
        payload: schema.outboxEvents.payload,
      })
      .from(schema.outboxEvents)
      .where(
        sql`${schema.outboxEvents.organizationId} = ${organizationId} and ${schema.outboxEvents.eventType} = 'CONFIGURATION_CHANGED'`,
      );
    expect(profileEvents).toContainEqual(
      expect.objectContaining({
        eventType: "CONFIGURATION_CHANGED",
        payload: expect.objectContaining({
          resource: "business_settings",
          changedFields: expect.arrayContaining(["contactEmail", "address"]),
        }),
      }),
    );
    const rereadProfile = await app.inject({
      method: "GET",
      url: profileUrl,
      cookies: { onecore_session: sessionSecret },
    });
    expect(rereadProfile.json().businessProfile).toEqual({
      contactEmail: "sales@acme.example",
      contactPhone: "+254700000000",
      website: "https://acme.example",
      countryCode: "KE",
      region: "Nairobi",
      city: "Nairobi",
      address: "Central Nairobi",
    });
    expect(rereadProfile.body).not.toContain("ownerEmail");

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
    for (const catalogPayload of [
      {
        name: "Empty price",
        type: "PRODUCT",
        unit: "each",
        price: "",
        currency: "KES",
      },
      {
        name: "Unknown currency",
        type: "PRODUCT",
        unit: "each",
        price: "10",
        currency: "ZZZ",
      },
    ]) {
      const invalidCatalog = await app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/business/catalog`,
        cookies: { onecore_session: sessionSecret },
        payload: catalogPayload,
      });
      expect(invalidCatalog.statusCode).toBe(400);
    }

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
    await authorizedApp.close();
  });

  it("administers tenant-scoped branches and lists only authorized members", async () => {
    const organizationRows = await database
      .insert(schema.organizations)
      .values({
        name: "Member Directory",
        slug: `member-directory-${crypto.randomUUID()}`,
        industry: "TEST",
        status: "ACTIVE",
      })
      .returning();
    const otherOrganizationRows = await database
      .insert(schema.organizations)
      .values({
        name: "Other Member Directory",
        slug: `other-member-directory-${crypto.randomUUID()}`,
        industry: "TEST",
        status: "ACTIVE",
      })
      .returning();
    const organization = organizationRows[0];
    const otherOrganization = otherOrganizationRows[0];
    if (!organization || !otherOrganization)
      throw new Error("Member directory organizations were not created");

    const userRows = await database
      .insert(schema.users)
      .values([
        {
          email: `directory-owner-${crypto.randomUUID()}@onecore.test`,
          displayName: "Zoe Directory Owner",
        },
        {
          email: `directory-member-${crypto.randomUUID()}@onecore.test`,
          displayName: "Alex Member",
        },
        {
          email: `directory-invite-${crypto.randomUUID()}@onecore.test`,
          displayName: "Bea Invited",
        },
        {
          email: `directory-foreign-${crypto.randomUUID()}@onecore.test`,
          displayName: "Foreign Member",
        },
      ])
      .returning();
    const [owner, firstMember, invitedMember, foreignMember] = userRows;
    if (!owner || !firstMember || !invitedMember || !foreignMember) {
      throw new Error("Member directory users were not created");
    }
    const memberships = await database
      .insert(schema.organizationMemberships)
      .values([
        {
          organizationId: organization.id,
          userId: owner.id,
          status: "ACTIVE",
          branchAccessMode: "ALL",
        },
        {
          organizationId: organization.id,
          userId: firstMember.id,
          status: "ACTIVE",
          branchAccessMode: "ASSIGNED",
        },
        {
          organizationId: organization.id,
          userId: invitedMember.id,
          status: "INVITED",
          branchAccessMode: "ASSIGNED",
        },
        {
          organizationId: otherOrganization.id,
          userId: foreignMember.id,
          status: "ACTIVE",
          branchAccessMode: "ASSIGNED",
        },
      ])
      .returning();
    const ownerMembership = memberships.find(
      (membership) => membership.userId === owner.id,
    );
    const firstMemberMembership = memberships.find(
      (membership) => membership.userId === firstMember.id,
    );
    const invitedMemberMembership = memberships.find(
      (membership) => membership.userId === invitedMember.id,
    );
    const foreignMembership = memberships.find(
      (membership) => membership.userId === foreignMember.id,
    );
    if (
      !ownerMembership ||
      !firstMemberMembership ||
      !invitedMemberMembership ||
      !foreignMembership
    ) {
      throw new Error("Member directory memberships were not created");
    }
    const [assignedRole, availableRole, protectedOwnerRole] = await database
      .insert(schema.roles)
      .values([
        {
          organizationId: organization.id,
          name: "Directory Reader",
          status: "ACTIVE",
        },
        {
          organizationId: organization.id,
          name: "Directory Operator",
          status: "ACTIVE",
        },
        {
          organizationId: organization.id,
          name: "Protected Organization Owner",
          status: "ACTIVE",
        },
      ])
      .returning();
    if (!assignedRole || !availableRole || !protectedOwnerRole) {
      throw new Error("Member directory roles were not created");
    }
    const [ownerPermission] = await database
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, "core.rbac.organization_owner.manage"))
      .limit(1);
    if (!ownerPermission) {
      throw new Error("The reserved owner permission is not provisioned");
    }
    await database.insert(schema.rolePermissions).values({
      organizationId: organization.id,
      roleId: protectedOwnerRole.id,
      permissionId: ownerPermission.id,
    });
    await database.insert(schema.membershipRoles).values({
      organizationId: organization.id,
      membershipId: firstMemberMembership.id,
      roleId: assignedRole.id,
    });
    await database.insert(schema.membershipRoles).values({
      organizationId: organization.id,
      membershipId: invitedMemberMembership.id,
      roleId: protectedOwnerRole.id,
    });

    const hiddenWithoutDirectoryContext = await database.transaction(
      async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
        await transaction.execute(
          sql`SELECT set_config('app.current_user_id', ${owner.id}, true)`,
        );
        await transaction.execute(
          sql`SELECT set_config('app.current_organization_id', ${organization.id}, true)`,
        );
        return transaction
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.id, firstMember.id));
      },
    );
    expect(hiddenWithoutDirectoryContext).toEqual([]);

    const sessionSecret = "m".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: owner.id,
      email: owner.email,
      displayName: owner.displayName,
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(owner.id, {
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      branchAccessMode: "ALL",
      membershipId: ownerMembership.id,
    });
    identity.sessions.set(secretHash, {
      id: crypto.randomUUID(),
      secretHash,
      userId: owner.id,
      organizationId: organization.id,
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
      allowBusinessManager(
        permissionKeys.filter((key) => key !== "core.organization.user.read"),
      ),
    );
    const denied = await app.inject({
      method: "GET",
      url: `/organizations/${organization.id}/members`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();

    const limitedScopeApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(permissionKeys, "BRANCH"),
    );
    const limitedScope = await limitedScopeApp.inject({
      method: "GET",
      url: `/organizations/${organization.id}/members`,
      cookies: { onecore_session: sessionSecret },
    });
    const limitedRoleScope = await limitedScopeApp.inject({
      method: "GET",
      url: `/organizations/${organization.id}/members/${firstMemberMembership.id}/roles`,
      cookies: { onecore_session: sessionSecret },
    });
    const limitedRoleAssignment = await limitedScopeApp.inject({
      method: "POST",
      url: "/auth/membership/roles",
      cookies: { onecore_session: sessionSecret },
      payload: {
        membershipId: firstMemberMembership.id,
        roleId: availableRole.id,
      },
    });
    const limitedRoleRemoval = await limitedScopeApp.inject({
      method: "DELETE",
      url: `/auth/membership/roles/${firstMemberMembership.id}/${assignedRole.id}`,
      cookies: { onecore_session: sessionSecret },
    });
    const limitedBranchRead = await limitedScopeApp.inject({
      method: "GET",
      url: `/organizations/${organization.id}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(limitedScope.statusCode).toBe(403);
    expect(limitedRoleScope.statusCode).toBe(403);
    expect(limitedRoleAssignment.statusCode).toBe(403);
    expect(limitedRoleRemoval.statusCode).toBe(403);
    expect(limitedBranchRead.statusCode).toBe(403);
    await limitedScopeApp.close();

    const authorizedApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(),
    );
    const anonymous = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${organization.id}/members`,
    });
    const invalidPagination = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${organization.id}/members?limit=101`,
      cookies: { onecore_session: sessionSecret },
    });
    const foreignOrganization = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${otherOrganization.id}/members`,
      cookies: { onecore_session: sessionSecret },
    });
    const firstPage = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${organization.id}/members?limit=2&offset=0`,
      cookies: { onecore_session: sessionSecret },
    });
    const secondPage = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${organization.id}/members?limit=2&offset=2`,
      cookies: { onecore_session: sessionSecret },
    });
    const memberRolesUrl = `/organizations/${organization.id}/members/${firstMemberMembership.id}/roles`;
    const memberRoles = await authorizedApp.inject({
      method: "GET",
      url: memberRolesUrl,
      cookies: { onecore_session: sessionSecret },
    });
    const branchesPath = `/organizations/${organization.id}/branches`;
    const initialBranchList = await authorizedApp.inject({
      method: "GET",
      url: `${branchesPath}?limit=1&offset=0`,
      cookies: { onecore_session: sessionSecret },
    });
    const invalidBranchList = await authorizedApp.inject({
      method: "GET",
      url: `${branchesPath}?limit=101`,
      cookies: { onecore_session: sessionSecret },
    });
    const foreignBranchList = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${otherOrganization.id}/branches`,
      cookies: { onecore_session: sessionSecret },
    });
    const createdBranch = await authorizedApp.inject({
      method: "POST",
      url: branchesPath,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Central", code: "central" },
    });
    const createdSecondBranch = await authorizedApp.inject({
      method: "POST",
      url: branchesPath,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "South", code: "south" },
    });
    const duplicateBranch = await authorizedApp.inject({
      method: "POST",
      url: branchesPath,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Duplicate code", code: "CENTRAL" },
    });
    const branchList = await authorizedApp.inject({
      method: "GET",
      url: `${branchesPath}?limit=1&offset=0`,
      cookies: { onecore_session: sessionSecret },
    });
    const createdBranchId = createdBranch.json().branch?.id;
    const updateBranch = await authorizedApp.inject({
      method: "PATCH",
      url: `${branchesPath}/${createdBranchId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Central Office", code: "central-office" },
    });
    const deactivateBranch = await authorizedApp.inject({
      method: "PATCH",
      url: `${branchesPath}/${createdBranchId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { status: "INACTIVE" },
    });
    const reactivateBranch = await authorizedApp.inject({
      method: "PATCH",
      url: `${branchesPath}/${createdBranchId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { status: "ACTIVE" },
    });
    const organizationMismatchUpdate = await authorizedApp.inject({
      method: "PATCH",
      url: `/organizations/${otherOrganization.id}/branches/${createdBranchId}`,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Must not move tenant" },
    });
    const foreignMemberRoles = await authorizedApp.inject({
      method: "GET",
      url: `/organizations/${otherOrganization.id}/members/${firstMemberMembership.id}/roles`,
      cookies: { onecore_session: sessionSecret },
    });
    const selfAssignment = await authorizedApp.inject({
      method: "POST",
      url: "/auth/membership/roles",
      cookies: { onecore_session: sessionSecret },
      payload: {
        membershipId: ownerMembership.id,
        roleId: availableRole.id,
      },
    });
    const ownerAssignment = await authorizedApp.inject({
      method: "POST",
      url: "/auth/membership/roles",
      cookies: { onecore_session: sessionSecret },
      payload: {
        membershipId: firstMemberMembership.id,
        roleId: protectedOwnerRole.id,
      },
    });
    const ownerRoleRemoval = await authorizedApp.inject({
      method: "DELETE",
      url: `/auth/membership/roles/${invitedMemberMembership.id}/${protectedOwnerRole.id}`,
      cookies: { onecore_session: sessionSecret },
    });
    const crossTenantAssignment = await authorizedApp.inject({
      method: "POST",
      url: "/auth/membership/roles",
      cookies: { onecore_session: sessionSecret },
      payload: {
        membershipId: foreignMembership.id,
        roleId: availableRole.id,
      },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(invalidPagination.statusCode).toBe(404);
    expect(foreignOrganization.statusCode).toBe(404);
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      limit: 2,
      offset: 0,
      hasMore: true,
      members: [
        {
          email: firstMember.email,
          displayName: firstMember.displayName,
          status: "ACTIVE",
        },
        {
          email: invitedMember.email,
          displayName: invitedMember.displayName,
          status: "INVITED",
        },
      ],
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({
      limit: 2,
      offset: 2,
      hasMore: false,
      members: [
        {
          email: owner.email,
          displayName: owner.displayName,
          status: "ACTIVE",
        },
      ],
    });
    expect(firstPage.body).not.toContain(foreignMember.email);
    expect(firstPage.body).not.toContain("passwordHash");
    expect(memberRoles.statusCode).toBe(200);
    expect(memberRoles.json()).toEqual({
      membershipId: firstMemberMembership.id,
      assignedRoles: [
        {
          id: assignedRole.id,
          name: assignedRole.name,
          status: "ACTIVE",
        },
      ],
      availableRoles: expect.arrayContaining([
        expect.objectContaining({ id: availableRole.id }),
      ]),
    });
    expect(memberRoles.json()).not.toHaveProperty("email");
    expect(memberRoles.json()).not.toHaveProperty("userId");
    expect(initialBranchList.statusCode).toBe(200);
    expect(initialBranchList.json()).toMatchObject({
      branches: [],
      hasMore: false,
    });
    expect(invalidBranchList.statusCode).toBe(404);
    expect(foreignBranchList.statusCode).toBe(404);
    expect(createdBranch.statusCode).toBe(201);
    expect(createdBranch.json().branch).toMatchObject({
      name: "Central",
      code: "CENTRAL",
      status: "ACTIVE",
    });
    expect(createdSecondBranch.statusCode).toBe(201);
    expect(duplicateBranch.statusCode).toBe(409);
    expect(branchList.statusCode).toBe(200);
    expect(branchList.json()).toMatchObject({
      limit: 1,
      offset: 0,
      hasMore: true,
      capabilities: { canCreate: true, canUpdate: true },
      branches: [expect.objectContaining({ name: "Central" })],
    });
    expect(updateBranch.statusCode).toBe(200);
    expect(updateBranch.json().branch).toMatchObject({
      name: "Central Office",
      code: "CENTRAL-OFFICE",
      status: "ACTIVE",
    });
    expect(deactivateBranch.json().branch.status).toBe("INACTIVE");
    expect(reactivateBranch.json().branch.status).toBe("ACTIVE");
    expect(organizationMismatchUpdate.statusCode).toBe(404);
    expect(foreignMemberRoles.statusCode).toBe(404);
    expect(selfAssignment.statusCode).toBe(403);
    expect(ownerAssignment.statusCode).toBe(403);
    expect(ownerRoleRemoval.statusCode).toBe(403);
    expect(crossTenantAssignment.statusCode).toBe(404);

    const deniedAssignmentApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(
        permissionKeys.filter(
          (key) => key !== "core.rbac.membership_role.assign",
        ),
      ),
    );
    const assignmentDenied = await deniedAssignmentApp.inject({
      method: "POST",
      url: "/auth/membership/roles",
      cookies: { onecore_session: sessionSecret },
      payload: {
        membershipId: firstMemberMembership.id,
        roleId: availableRole.id,
      },
    });
    expect(assignmentDenied.statusCode).toBe(403);
    await deniedAssignmentApp.close();

    const deniedRemovalApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(
        permissionKeys.filter(
          (key) => key !== "core.rbac.membership_role.remove",
        ),
      ),
    );
    const removalDenied = await deniedRemovalApp.inject({
      method: "DELETE",
      url: `/auth/membership/roles/${firstMemberMembership.id}/${assignedRole.id}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(removalDenied.statusCode).toBe(403);
    await deniedRemovalApp.close();

    const noRoleReadApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(
        permissionKeys.filter((key) => key !== "core.rbac.role.read"),
      ),
    );
    const roleReadDenied = await noRoleReadApp.inject({
      method: "GET",
      url: memberRolesUrl,
      cookies: { onecore_session: sessionSecret },
    });
    expect(roleReadDenied.statusCode).toBe(403);
    await noRoleReadApp.close();

    const assigned = await authorizedApp.inject({
      method: "POST",
      url: "/auth/membership/roles",
      cookies: { onecore_session: sessionSecret },
      payload: {
        membershipId: firstMemberMembership.id,
        roleId: availableRole.id,
      },
    });
    expect(assigned.statusCode).toBe(201);
    const assignmentPersisted = await database
      .select()
      .from(schema.membershipRoles)
      .where(
        sql`${schema.membershipRoles.organizationId} = ${organization.id}
          and ${schema.membershipRoles.membershipId} = ${firstMemberMembership.id}
          and ${schema.membershipRoles.roleId} = ${availableRole.id}`,
      );
    expect(assignmentPersisted).toHaveLength(1);
    const removed = await authorizedApp.inject({
      method: "DELETE",
      url: `/auth/membership/roles/${firstMemberMembership.id}/${availableRole.id}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(removed.statusCode).toBe(200);
    const assignmentRemoved = await database
      .select()
      .from(schema.membershipRoles)
      .where(
        sql`${schema.membershipRoles.organizationId} = ${organization.id}
          and ${schema.membershipRoles.membershipId} = ${firstMemberMembership.id}
          and ${schema.membershipRoles.roleId} = ${availableRole.id}`,
      );
    expect(assignmentRemoved).toHaveLength(0);
    const roleChangeEvents = await database
      .select({ payload: schema.outboxEvents.payload })
      .from(schema.outboxEvents)
      .where(
        sql`${schema.outboxEvents.organizationId} = ${organization.id}
          and ${schema.outboxEvents.eventType} = 'USER_ROLE_CHANGED'`,
      );
    expect(roleChangeEvents.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          membershipId: firstMemberMembership.id,
          roleId: availableRole.id,
          change: "ASSIGNED",
        }),
        expect.objectContaining({
          membershipId: firstMemberMembership.id,
          roleId: availableRole.id,
          change: "REMOVED",
        }),
      ]),
    );
    const roleAssignmentResource = `${firstMemberMembership.id}:${availableRole.id}`;
    const roleChangeAudit = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(
        sql`${schema.auditLogs.organizationId} = ${organization.id}
          and ${schema.auditLogs.resource} = 'membership_role'
          and ${schema.auditLogs.resourceId} = ${roleAssignmentResource}`,
      );
    expect(roleChangeAudit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "membership.role.assigned",
        "membership.role.removed",
      ]),
    );
    const branchAudit = await database
      .select({
        action: schema.auditLogs.action,
        resourceId: schema.auditLogs.resourceId,
      })
      .from(schema.auditLogs)
      .where(
        sql`${schema.auditLogs.organizationId} = ${organization.id}
          and ${schema.auditLogs.resource} = 'branch'
          and ${schema.auditLogs.resourceId} = ${createdBranchId}`,
      );
    expect(branchAudit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "branch.created",
        "branch.updated",
        "branch.updated",
        "branch.updated",
      ]),
    );
    const deniedBranchApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(
        permissionKeys.filter(
          (key) => key !== "core.organization.branch.create",
        ),
      ),
    );
    const branchCreateDenied = await deniedBranchApp.inject({
      method: "POST",
      url: branchesPath,
      cookies: { onecore_session: sessionSecret },
      payload: { name: "Denied", code: "DENIED" },
    });
    expect(branchCreateDenied.statusCode).toBe(403);
    await deniedBranchApp.close();
    const readOnlyBranchApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowBusinessManager(
        permissionKeys.filter(
          (key) =>
            key !== "core.organization.branch.create" &&
            key !== "core.organization.branch.update",
        ),
      ),
    );
    const readOnlyBranchList = await readOnlyBranchApp.inject({
      method: "GET",
      url: branchesPath,
      cookies: { onecore_session: sessionSecret },
    });
    expect(readOnlyBranchList.statusCode).toBe(200);
    expect(readOnlyBranchList.json().capabilities).toEqual({
      canCreate: false,
      canUpdate: false,
    });
    await readOnlyBranchApp.close();
    await authorizedApp.close();
  });
});
