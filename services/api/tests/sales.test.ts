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
  VerifiedBranch,
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
  "sales.sale.create",
  "sales.sale.read",
  "sales.sale.cancel",
  "sales.sale.refund",
  "sales.sale.discount",
  "sales.sale.payment_record",
] as const;

function allowSales(
  ownScopedPermissions: readonly string[] = [],
  deniedPermissions: readonly string[] = [],
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
    if (
      !permissionKeys.includes(permissionKey as (typeof permissionKeys)[number]) ||
      deniedPermissions.includes(permissionKey)
    ) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }
    const branch: VerifiedBranch = {
      branchId: requestContext.branchId ?? crypto.randomUUID(),
      name: "Main Branch",
      code: "MAIN",
    };
    const context: ResolvedAuthorizationContext = {
      userId: requestContext.userId,
      sessionId: requestContext.sessionId,
      organizationId: requestContext.organizationId,
      membershipId: requestContext.membershipId,
      branchId: branch.branchId,
      branch,
      branchAccessMode: "ALL",
      roles: [],
      platformRoles: [],
      permissions: permissionKeys
        .filter((key) => !deniedPermissions.includes(key))
        .map((key) => ({
        key,
        moduleKey: "sales",
        scopeType: ownScopedPermissions.includes(key) ? "OWN" : "ORGANIZATION",
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
      await transaction.execute(
        sql`SELECT set_config('app.current_branch_id', ${context.branchId}, true)`,
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

describe("Sales API", () => {
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

  it("checks out, lists, and refunds a sale with tenant-scoped authorization", async () => {
    const tenant = await database
      .insert(schema.organizations)
      .values({
        name: "Sales API",
        slug: `sales-api-${crypto.randomUUID()}`,
        industry: "TEST",
        status: "ACTIVE",
      })
      .returning();
    const organization = tenant[0];
    if (!organization) throw new Error("Organization fixture not created");
    await database.insert(schema.businessSettings).values({
      organizationId: organization.id,
      paymentMethods: ["CASH"],
    });
    const branch = await database
      .insert(schema.branches)
      .values({
        organizationId: organization.id,
        name: "Main Branch",
        code: "MAIN",
        status: "ACTIVE",
      })
      .returning();
    const branchRecord = branch[0];
    if (!branchRecord) throw new Error("Branch fixture not created");
    const otherBranchRows = await database
      .insert(schema.branches)
      .values({
        organizationId: organization.id,
        name: "Other Branch",
        code: "OTHER",
        status: "ACTIVE",
      })
      .returning();
    const otherBranch = otherBranchRows[0];
    if (!otherBranch) throw new Error("Other branch fixture not created");

    const userRows = await database
      .insert(schema.users)
      .values({
        email: "sales-api@onecore.test",
        displayName: "Sales API User",
      })
      .returning();
    const user = userRows[0];
    if (!user) throw new Error("User fixture not created");

    const otherUserRows = await database
      .insert(schema.users)
      .values({
        email: "other-sales-api@onecore.test",
        displayName: "Other Sales API User",
      })
      .returning();
    const otherUser = otherUserRows[0];
    if (!otherUser) throw new Error("Other user fixture not created");

    await database.insert(schema.organizationMemberships).values({
      organizationId: organization.id,
      userId: user.id,
      status: "ACTIVE",
    });
    const member = await database
      .select()
      .from(schema.organizationMemberships)
      .where(
        sql`${schema.organizationMemberships.organizationId} = ${organization.id} AND ${schema.organizationMemberships.userId} = ${user.id}`,
      )
      .limit(1);
    if (!member[0]) throw new Error("Membership fixture not created");

    const catalogRow = await database
      .insert(schema.catalogItems)
      .values({
        organizationId: organization.id,
        branchId: branchRecord.id,
        reference: "SKU-1",
        name: "Widget",
        type: "PRODUCT",
        unit: "each",
        price: "12.500000",
        currency: "KES",
        status: "ACTIVE",
        createdByUserId: user.id,
      })
      .returning();
    const catalogItem = catalogRow[0];
    if (!catalogItem) throw new Error("Catalog fixture not created");

    const customerRow = await database
      .insert(schema.customers)
      .values({
        organizationId: organization.id,
        branchId: branchRecord.id,
        reference: "CUST-1",
        name: "Acme",
        customerType: "BUSINESS",
        email: "sales@acme.example",
        status: "ACTIVE",
        createdByUserId: user.id,
      })
      .returning();
    const customer = customerRow[0];
    if (!customer) throw new Error("Customer fixture not created");
    const otherBranchCustomerRows = await database
      .insert(schema.customers)
      .values({
        organizationId: organization.id,
        branchId: otherBranch.id,
        name: "Other Branch Customer",
        customerType: "BUSINESS",
        status: "ACTIVE",
        createdByUserId: user.id,
      })
      .returning();
    const otherBranchCustomer = otherBranchCustomerRows[0];
    if (!otherBranchCustomer)
      throw new Error("Other branch customer fixture not created");

    const sessionSecret = "sales-session-123".padEnd(43, "x");
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addUser({
      id: otherUser.id,
      email: otherUser.email,
      displayName: otherUser.displayName,
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(user.id, {
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      branchAccessMode: "ALL",
    });
    identity.addBranchAccess(user.id, organization.id, {
      branchId: branchRecord.id,
      name: branchRecord.name,
      code: branchRecord.code,
    });
    identity.addMembership(otherUser.id, {
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      branchAccessMode: "ALL",
    });
    identity.addBranchAccess(otherUser.id, organization.id, {
      branchId: branchRecord.id,
      name: branchRecord.name,
      code: branchRecord.code,
    });
    identity.sessions.set(secretHash, {
      id: crypto.randomUUID(),
      secretHash,
      userId: user.id,
      organizationId: organization.id,
      branchId: branchRecord.id,
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: new Date(),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });
    const otherSessionSecret = "other-sales-session-123".padEnd(43, "x");
    const otherSecretHash = createHash("sha256")
      .update(otherSessionSecret)
      .digest("hex");
    identity.sessions.set(otherSecretHash, {
      id: crypto.randomUUID(),
      secretHash: otherSecretHash,
      userId: otherUser.id,
      organizationId: organization.id,
      branchId: branchRecord.id,
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: new Date(),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });

    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowSales(),
    );

    const catalogList = await app.inject({
      method: "GET",
      url: `/organizations/${organization.id}/sales/catalog?search=widget`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(catalogList.statusCode).toBe(200);
    expect(catalogList.json()).toMatchObject({
      items: [{ id: catalogItem.id, name: "Widget" }],
    });

    const noPaymentPermissionApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowSales([], ["sales.sale.payment_record"]),
    );
    const paymentDenied = await noPaymentPermissionApp.inject({
      method: "POST",
      url: `/organizations/${organization.id}/sales`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        idempotencyKey: "sale-payment-denied-001",
        items: [{ catalogItemId: catalogItem.id, quantity: 1 }],
        paymentMethod: "CASH",
      },
    });
    expect(paymentDenied.statusCode).toBe(403);
    const salesAfterPaymentDenied = await database
      .select({ id: schema.sales.id })
      .from(schema.sales)
      .where(sql`${schema.sales.organizationId} = ${organization.id}`);
    expect(salesAfterPaymentDenied).toEqual([]);
    await noPaymentPermissionApp.close();

    const crossBranchCustomerSale = await app.inject({
      method: "POST",
      url: `/organizations/${organization.id}/sales`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        idempotencyKey: "sale-other-branch-001",
        customerId: otherBranchCustomer.id,
        items: [{ catalogItemId: catalogItem.id, quantity: 1 }],
        paymentMethod: "CASH",
      },
    });
    expect(crossBranchCustomerSale.statusCode).toBe(404);
    const salesAfterRejectedCheckout = await database
      .select({ id: schema.sales.id })
      .from(schema.sales)
      .where(sql`${schema.sales.organizationId} = ${organization.id}`);
    expect(salesAfterRejectedCheckout).toEqual([]);

    const saleResponse = await app.inject({
      method: "POST",
      url: `/organizations/${organization.id}/sales`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        idempotencyKey: "sale-1-000001",
        customerId: customer.id,
        items: [{ catalogItemId: catalogItem.id, quantity: 2 }],
        paymentMethod: "CASH",
      },
    });
    expect(saleResponse.statusCode).toBe(201);
    expect(saleResponse.json()).toMatchObject({
      sale: { currency: "KES", total: "25.000000" },
      payment: { paymentMethod: "CASH" },
    });
    const saleId = saleResponse.json().sale.id as string;

    const listResponse = await app.inject({
      method: "GET",
      url: `/organizations/${organization.id}/sales?limit=10`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(
      listResponse
        .json()
        .items.some((item: { id: string }) => item.id === saleId),
    ).toBe(true);

    const ownScopedApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowSales(["sales.sale.cancel", "sales.sale.refund"]),
    );
    const ownScopedCancel = await ownScopedApp.inject({
      method: "POST",
      url: `/organizations/${organization.id}/sales/${saleId}/cancel`,
      cookies: { onecore_session: otherSessionSecret },
      payload: { reason: "Not my sale" },
    });
    expect(ownScopedCancel.statusCode).toBe(404);
    const ownScopedRefund = await ownScopedApp.inject({
      method: "POST",
      url: `/organizations/${organization.id}/sales/${saleId}/refunds`,
      cookies: { onecore_session: otherSessionSecret },
      payload: {
        idempotencyKey: "refund-other-0001",
        amount: "1.000000",
        reason: "Not my sale",
      },
    });
    expect(ownScopedRefund.statusCode).toBe(404);

    const refundResponse = await app.inject({
      method: "POST",
      url: `/organizations/${organization.id}/sales/${saleId}/refunds`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        idempotencyKey: "refund-1-000001",
        amount: "10.000000",
        reason: "Customer requested refund",
      },
    });
    expect(refundResponse.statusCode).toBe(201);
    expect(refundResponse.json().refund.amount).toBe("10.000000");
    const unauthorizedRefundReplay = await ownScopedApp.inject({
      method: "POST",
      url: `/organizations/${organization.id}/sales/${saleId}/refunds`,
      cookies: { onecore_session: otherSessionSecret },
      payload: {
        idempotencyKey: "refund-1-000001",
        amount: "10.000000",
        reason: "Customer requested refund",
      },
    });
    expect(unauthorizedRefundReplay.statusCode).toBe(404);
    await ownScopedApp.close();

    await app.close();
  });
});
