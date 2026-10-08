import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  catalogItemCreateInputSchema,
  customerCreateInputSchema,
} from "@onecore/core-domain";
import {
  createCatalogItem,
  createCustomer,
  deleteCatalogItem,
  deleteCustomer,
  getCatalogItem,
  getCustomer,
  listCatalogItems,
  listCustomers,
  updateCatalogItem,
  updateCustomer,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
} from "../src/index.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
let client: PGlite;
let database: PgliteDatabase;

async function withTenant<T>(
  organizationId: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    return operation(transaction as unknown as OrganizationTransaction);
  });
}

function authorizationContext(
  organizationId: string,
  userId: string,
  scopeType: "ORGANIZATION" | "BRANCH" = "ORGANIZATION",
  branchId: string | null = null,
): ResolvedAuthorizationContext {
  return {
    userId,
    sessionId: crypto.randomUUID(),
    organizationId,
    membershipId: crypto.randomUUID(),
    branchId,
    branch:
      branchId === null
        ? null
        : { branchId, name: "Current branch", code: "CURRENT" },
    branchAccessMode: "ALL",
    roles: [],
    platformRoles: [],
    permissions: [
      ...["customer", "catalog"].flatMap((resource) =>
        ["create", "read", "update", "delete"].map((action) => ({
          key: `core.business_manager.${resource}.${action}`,
          moduleKey: "core.business_manager",
          scopeType,
          scope: {},
        })),
      ),
    ],
  };
}

async function createOrganization(name: string) {
  const [organization] = await database
    .insert(schema.organizations)
    .values({
      name,
      slug: `${name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID()}`,
      industry: "TEST",
      status: "ACTIVE",
    })
    .returning();
  if (!organization) throw new Error("Test organization was not created");
  return organization;
}

describe("Business Manager persistence and authorization scopes", () => {
  beforeAll(async () => {
    client = new PGlite();
    database = drizzle({ client });
    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    `);
    await applyTestMigrations(client, migrationsDirectory);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("persists customers and catalog items and applies tenant and branch scopes", async () => {
    const tenantA = await createOrganization("Business A");
    const tenantB = await createOrganization("Business B");
    const [userA, userB] = await database
      .insert(schema.users)
      .values([
        { email: "owner-a@business.test", displayName: "Owner A" },
        { email: "owner-b@business.test", displayName: "Owner B" },
      ])
      .returning();
    if (!userA || !userB) throw new Error("Test users were not created");
    const [branchA, branchB] = await database
      .insert(schema.branches)
      .values([
        { organizationId: tenantA.id, name: "Branch A", code: "A" },
        { organizationId: tenantA.id, name: "Branch B", code: "B" },
      ])
      .returning();
    if (!branchA || !branchB) throw new Error("Test branches were not created");

    const branchContextA = authorizationContext(
      tenantA.id,
      userA.id,
      "BRANCH",
      branchA.id,
    );
    const customerA = await withTenant(tenantA.id, (transaction) =>
      createCustomer(
        transaction,
        branchContextA,
        customerCreateInputSchema.parse({
          reference: "shared-ref",
          name: "Branch A customer",
          customerType: "INDIVIDUAL",
        }),
      ),
    );
    expect(customerA?.branchId).toBe(branchA.id);
    expect(
      await withTenant(tenantA.id, (transaction) =>
        createCustomer(
          transaction,
          branchContextA,
          customerCreateInputSchema.parse({
            branchId: branchB.id,
            name: "Forged branch customer",
            customerType: "BUSINESS",
          }),
        ),
      ),
    ).toBeUndefined();
    const branchContextB = authorizationContext(
      tenantA.id,
      userA.id,
      "BRANCH",
      branchB.id,
    );
    const branchCustomerB = await withTenant(tenantA.id, (transaction) =>
      createCustomer(
        transaction,
        branchContextB,
        customerCreateInputSchema.parse({
          name: "Branch B customer",
          customerType: "BUSINESS",
        }),
      ),
    );
    expect(branchCustomerB?.branchId).toBe(branchB.id);

    const organizationContextA = authorizationContext(tenantA.id, userA.id);
    const organizationCustomer = await withTenant(tenantA.id, (transaction) =>
      createCustomer(
        transaction,
        organizationContextA,
        customerCreateInputSchema.parse({
          name: "Organization-wide customer",
          customerType: "BUSINESS",
        }),
      ),
    );
    const itemA = await withTenant(tenantA.id, (transaction) =>
      createCatalogItem(
        transaction,
        branchContextA,
        catalogItemCreateInputSchema.parse({
          name: "Consulting",
          type: "SERVICE",
          unit: "hour",
          price: "0.100001",
          currency: "KES",
        }),
      ),
    );
    expect(itemA?.price).toBe("0.100001");
    const organizationCatalogItem = await withTenant(
      tenantA.id,
      (transaction) =>
        createCatalogItem(
          transaction,
          organizationContextA,
          catalogItemCreateInputSchema.parse({
            name: "Organization-wide service",
            type: "SERVICE",
            unit: "hour",
            price: "15",
            currency: "KES",
          }),
        ),
    );

    const itemB = await database
      .insert(schema.catalogItems)
      .values({
        organizationId: tenantA.id,
        branchId: branchB.id,
        name: "Other branch product",
        type: "PRODUCT",
        unit: "each",
        price: "10.000000",
        currency: "KES",
        createdByUserId: userA.id,
      })
      .returning();
    const contextB = authorizationContext(tenantB.id, userB.id);
    const customerB = await withTenant(tenantB.id, (transaction) =>
      createCustomer(
        transaction,
        contextB,
        customerCreateInputSchema.parse({
          reference: "SHARED-REF",
          name: "Tenant B customer",
          customerType: "BUSINESS",
        }),
      ),
    );
    expect(customerB).toBeDefined();

    const branchList = await withTenant(tenantA.id, (transaction) =>
      listCustomers(transaction, branchContextA, {
        branchId: branchA.id,
        limit: 50,
        offset: 0,
      }),
    );
    expect(branchList?.items.map(({ id }) => id).sort()).toEqual(
      [customerA?.id, organizationCustomer?.id].sort(),
    );
    const branchCatalog = await withTenant(tenantA.id, (transaction) =>
      listCatalogItems(transaction, branchContextA, {
        branchId: branchA.id,
        limit: 50,
        offset: 0,
      }),
    );
    expect(branchCatalog?.items.map(({ id }) => id).sort()).toEqual(
      [itemA?.id, organizationCatalogItem?.id].sort(),
    );

    expect(
      await withTenant(tenantA.id, (transaction) =>
        getCustomer(transaction, branchContextA, branchCustomerB!.id),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        getCustomer(transaction, branchContextA, organizationCustomer!.id),
      ),
    ).toMatchObject({ branchId: null });
    expect(
      await withTenant(tenantA.id, (transaction) =>
        updateCustomer(transaction, branchContextA, organizationCustomer!.id, {
          name: "Unauthorized shared update",
        }),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        deleteCustomer(transaction, branchContextA, organizationCustomer!.id),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        getCatalogItem(transaction, branchContextA, itemB[0]!.id),
      ),
    ).toBeUndefined();

    const allCatalog = await withTenant(tenantA.id, (transaction) =>
      listCatalogItems(transaction, organizationContextA, {
        limit: 50,
        offset: 0,
      }),
    );
    expect(allCatalog?.items).toHaveLength(3);
  });

  it("blocks cross-tenant reads, writes and inserts through forced RLS", async () => {
    const tenantA = await createOrganization("Isolation A");
    const tenantB = await createOrganization("Isolation B");
    const [userA, userB] = await database
      .insert(schema.users)
      .values([
        { email: "isolation-a@business.test", displayName: "Isolation A" },
        { email: "isolation-b@business.test", displayName: "Isolation B" },
      ])
      .returning();
    if (!userA || !userB) throw new Error("Test users were not created");
    const customerB = await database
      .insert(schema.customers)
      .values({
        organizationId: tenantB.id,
        name: "Private customer",
        customerType: "BUSINESS",
        createdByUserId: userB.id,
      })
      .returning();
    if (!customerB[0]) throw new Error("Test customer was not created");
    const catalogB = await database
      .insert(schema.catalogItems)
      .values({
        organizationId: tenantB.id,
        reference: "PRIVATE-SKU",
        name: "Private catalog item",
        type: "PRODUCT",
        unit: "each",
        price: "1.000000",
        currency: "KES",
        createdByUserId: userB.id,
      })
      .returning();
    if (!catalogB[0]) throw new Error("Test catalog item was not created");

    const contextA = authorizationContext(tenantA.id, userA.id);
    expect(
      await withTenant(tenantA.id, (transaction) =>
        getCustomer(transaction, contextA, customerB[0]!.id),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        updateCustomer(transaction, contextA, customerB[0]!.id, { name: "No" }),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        deleteCustomer(transaction, contextA, customerB[0]!.id),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        getCatalogItem(transaction, contextA, catalogB[0]!.id),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        updateCatalogItem(transaction, contextA, catalogB[0]!.id, {
          name: "No",
        }),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(tenantA.id, (transaction) =>
        deleteCatalogItem(transaction, contextA, catalogB[0]!.id),
      ),
    ).toBeUndefined();

    await expect(
      withTenant(tenantA.id, (transaction) =>
        transaction.insert(schema.customers).values({
          organizationId: tenantB.id,
          name: "Forged tenant insert",
          customerType: "BUSINESS",
          createdByUserId: userA.id,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantA.id, (transaction) =>
        transaction.insert(schema.catalogItems).values({
          organizationId: tenantB.id,
          name: "Forged tenant catalog insert",
          type: "PRODUCT",
          unit: "each",
          price: "1.000000",
          currency: "KES",
          createdByUserId: userA.id,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantA.id, (transaction) =>
        transaction
          .update(schema.customers)
          .set({ name: "Forged tenant update" })
          .where(eq(schema.customers.id, customerB[0]!.id)),
      ),
    ).resolves.toBeDefined();
    const stillPrivate = await database
      .select({ name: schema.customers.name })
      .from(schema.customers)
      .where(
        and(
          eq(schema.customers.id, customerB[0]!.id),
          eq(schema.customers.organizationId, tenantB.id),
        ),
      );
    expect(stillPrivate[0]?.name).toBe("Private customer");
    const catalogStillPrivate = await database
      .select({ name: schema.catalogItems.name })
      .from(schema.catalogItems)
      .where(
        and(
          eq(schema.catalogItems.id, catalogB[0]!.id),
          eq(schema.catalogItems.organizationId, tenantB.id),
        ),
      );
    expect(catalogStillPrivate[0]?.name).toBe("Private catalog item");

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
        await transaction.insert(schema.customers).values({
          organizationId: tenantA.id,
          name: "No tenant context",
          customerType: "INDIVIDUAL",
          createdByUserId: userA.id,
        });
      }),
    ).rejects.toThrow();
    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
        await transaction.insert(schema.catalogItems).values({
          organizationId: tenantA.id,
          name: "No tenant context",
          type: "PRODUCT",
          unit: "each",
          price: "1.000000",
          currency: "KES",
          createdByUserId: userA.id,
        });
      }),
    ).rejects.toThrow();
  });

  it("forces tenant RLS policies and tenant-scoped unique master-data references", async () => {
    const tables = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('customers', 'catalog_items')
    `);
    expect(tables.rows).toHaveLength(2);
    for (const table of tables.rows) {
      expect(table.relrowsecurity).toBe(true);
      expect(table.relforcerowsecurity).toBe(true);
    }
    const policies = await client.query<{
      tablename: string;
      qual: string;
      with_check: string;
    }>(`
      SELECT tablename, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('customers', 'catalog_items')
    `);
    expect(policies.rows).toHaveLength(2);
    for (const policy of policies.rows) {
      expect(policy.qual).toContain("app.current_organization_id");
      expect(policy.with_check).toContain("app.current_organization_id");
    }
    const referenceIndexes = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'customers_org_reference_unique',
          'catalog_items_org_reference_unique'
        )
    `);
    expect(
      referenceIndexes.rows.map(({ indexname }) => indexname).sort(),
    ).toEqual([
      "catalog_items_org_reference_unique",
      "customers_org_reference_unique",
    ]);
  });

  it("updates and deactivates catalog/customer records without deleting identity", async () => {
    const organization = await createOrganization("Lifecycle");
    const [user] = await database
      .insert(schema.users)
      .values({
        email: "lifecycle@business.test",
        displayName: "Lifecycle Owner",
      })
      .returning();
    if (!user) throw new Error("Test user was not created");
    const context = authorizationContext(organization.id, user.id);
    const customer = await withTenant(organization.id, (transaction) =>
      createCustomer(
        transaction,
        context,
        customerCreateInputSchema.parse({
          reference: "customer-1",
          name: "Before",
          customerType: "INDIVIDUAL",
        }),
      ),
    );
    const catalog = await withTenant(organization.id, (transaction) =>
      createCatalogItem(
        transaction,
        context,
        catalogItemCreateInputSchema.parse({
          reference: "svc-1",
          name: "Before",
          type: "SERVICE",
          unit: "hour",
          price: "12.25",
          currency: "KES",
        }),
      ),
    );
    expect(customer).toBeDefined();
    expect(catalog).toBeDefined();
    const updatedCustomer = await withTenant(organization.id, (transaction) =>
      updateCustomer(transaction, context, customer!.id, { name: "After" }),
    );
    const updatedCatalog = await withTenant(organization.id, (transaction) =>
      updateCatalogItem(transaction, context, catalog!.id, { price: "20" }),
    );
    expect(updatedCustomer?.name).toBe("After");
    expect(updatedCatalog?.price).toBe("20.000000");
    const deactivated = await withTenant(organization.id, (transaction) =>
      deleteCustomer(transaction, context, customer!.id),
    );
    expect(deactivated?.status).toBe("INACTIVE");
    const retained = await database
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, customer!.id));
    expect(retained).toHaveLength(1);
  });
});
