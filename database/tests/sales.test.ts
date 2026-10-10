import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Database,
  OrganizationTransaction,
  ResolvedAuthorizationContext,
} from "../src/index.js";
import {
  adjustBranchStock,
  createAuthorizationService,
  createSale,
  getSale,
  listSales,
} from "../src/index.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const salesMigrationPath = fileURLToPath(
  new URL(
    "../migrations/20261010184156_sales_checkout_foundation/migration.sql",
    import.meta.url,
  ),
);
let client: PGlite;
let database: PgliteDatabase;

async function withTenant<T>(
  organizationId: string,
  branchId: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    await transaction.execute(
      sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`,
    );
    return operation(transaction as unknown as OrganizationTransaction);
  });
}

function authorizationContext(
  organizationId: string,
  userId: string,
  branchId: string,
): ResolvedAuthorizationContext {
  return {
    userId,
    sessionId: crypto.randomUUID(),
    organizationId,
    membershipId: crypto.randomUUID(),
    branchId,
    branch: { branchId, name: "Sales branch", code: "SALES" },
    branchAccessMode: "ALL",
    roles: [],
    platformRoles: [],
    permissions: [
      "core.sales.sale.create",
      "core.sales.sale.read",
      "core.sales.sale.cancel",
      "core.inventory.stock.read",
      "core.inventory.stock.adjust",
      "core.inventory.stock.reserve",
      "core.inventory.stock.release",
      "core.business_manager.catalog.read",
    ].map((key) => ({
      key,
      moduleKey: key.startsWith("core.inventory")
        ? "core.inventory"
        : key.startsWith("core.business_manager")
          ? "core.business_manager"
          : "core.sales",
      scopeType: "BRANCH" as const,
      scope: {},
    })),
  };
}

async function receiveStock(
  organizationId: string,
  userId: string,
  branchId: string,
  catalogItemId: string,
  delta: number,
) {
  return withTenant(organizationId, branchId, (transaction) =>
    adjustBranchStock(
      transaction,
      authorizationContext(organizationId, userId, branchId),
      { catalogItemId, movementType: "RECEIPT", delta },
      `receipt-${crypto.randomUUID()}`,
      crypto.randomUUID(),
    ),
  );
}

async function createTenant(name: string) {
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
  const [user] = await database
    .insert(schema.users)
    .values({ email: `${crypto.randomUUID()}@sales.test`, displayName: "Cashier" })
    .returning();
  if (!user) throw new Error("Test user was not created");
  const [branch] = await database
    .insert(schema.branches)
    .values({ organizationId: organization.id, name: "Sales branch", code: "SALES" })
    .returning();
  if (!branch) throw new Error("Test branch was not created");
  return { organization, user, branch };
}

async function createCatalogItem(
  organizationId: string,
  userId: string,
  options: {
    branchId?: string | null;
    name?: string;
    reference?: string | null;
    price?: string;
    currency?: string;
    status?: "ACTIVE" | "INACTIVE";
  } = {},
) {
  const [item] = await database
    .insert(schema.catalogItems)
    .values({
      organizationId,
      branchId: options.branchId ?? null,
      name: options.name ?? "Catalog item",
      description: "Historical description",
      reference: options.reference ?? null,
      type: "PRODUCT",
      unit: "each",
      price: options.price ?? "0.100001",
      currency: options.currency ?? "KES",
      status: options.status ?? "ACTIVE",
      createdByUserId: userId,
    })
    .returning();
  if (!item) throw new Error("Test catalog item was not created");
  return item;
}

describe("Sales persistence", () => {
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

  it("preserves disabled Sales module and permissions when provisioning is replayed", async () => {
    const statements = (await readFile(salesMigrationPath, "utf8"))
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim());
    const moduleProvisioning = statements.find((statement) =>
      statement.startsWith('INSERT INTO "modules"'),
    );
    const permissionProvisioning = statements.find((statement) =>
      statement.startsWith('INSERT INTO "permissions"'),
    );
    if (!moduleProvisioning || !permissionProvisioning) {
      throw new Error("Sales module and permission provisioning was not found");
    }

    const [salesModule] = await database
      .select({
        lifecycle: schema.modules.lifecycle,
        isAvailable: schema.modules.isAvailable,
      })
      .from(schema.modules)
      .where(eq(schema.modules.key, "core.sales"));
    const permissions = await database
      .select({
        key: schema.permissions.key,
        status: schema.permissions.status,
      })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [
          "core.sales.sale.create",
          "core.sales.sale.read",
        ]),
      );
    if (!salesModule || permissions.length !== 2) {
      throw new Error("Sales provisioning rows were not migrated");
    }

    try {
      await database
        .update(schema.modules)
        .set({ lifecycle: "RETIRED", isAvailable: false })
        .where(eq(schema.modules.key, "core.sales"));
      await database
        .update(schema.permissions)
        .set({ status: "INACTIVE" })
        .where(
          inArray(schema.permissions.key, [
            "core.sales.sale.create",
            "core.sales.sale.read",
          ]),
        );
      await client.exec(moduleProvisioning);
      await client.exec(permissionProvisioning);

      const [disabledModule] = await database
        .select({
          lifecycle: schema.modules.lifecycle,
          isAvailable: schema.modules.isAvailable,
        })
        .from(schema.modules)
        .where(eq(schema.modules.key, "core.sales"));
      const disabledPermissions = await database
        .select({
          key: schema.permissions.key,
          status: schema.permissions.status,
        })
        .from(schema.permissions)
        .where(
          inArray(schema.permissions.key, [
            "core.sales.sale.create",
            "core.sales.sale.read",
          ]),
        );
      expect(disabledModule).toEqual({
        lifecycle: "RETIRED",
        isAvailable: false,
      });
      expect(disabledPermissions.map(({ status }) => status)).toEqual([
        "INACTIVE",
        "INACTIVE",
      ]);
    } finally {
      await database
        .update(schema.modules)
        .set({
          lifecycle: salesModule.lifecycle,
          isAvailable: salesModule.isAvailable,
        })
        .where(eq(schema.modules.key, "core.sales"));
      for (const permission of permissions) {
        await database
          .update(schema.permissions)
          .set({ status: permission.status })
          .where(eq(schema.permissions.key, permission.key));
      }
    }
  });

  it("persists exact totals and historical catalog snapshots under forced RLS", async () => {
    const fixture = await createTenant("Sales snapshot");
    const item = await createCatalogItem(
      fixture.organization.id,
      fixture.user.id,
      { branchId: fixture.branch.id, reference: "SKU-1" },
    );
    expect(
      await receiveStock(
        fixture.organization.id,
        fixture.user.id,
        fixture.branch.id,
        item.id,
        10,
      ),
    ).toMatchObject({ outcome: "CREATED", stock: { onHand: 10, reserved: 0 } });
    const context = authorizationContext(
      fixture.organization.id,
      fixture.user.id,
      fixture.branch.id,
    );
    const result = await withTenant(
      fixture.organization.id,
      fixture.branch.id,
      (transaction) =>
        createSale(
          transaction,
          context,
          { lines: [{ catalogItemId: item.id, quantity: 3 }] },
          "snapshot-request-1",
        ),
    );
    expect(result).toMatchObject({
      outcome: "CREATED",
      sale: {
        status: "OPEN",
        currency: "KES",
        subtotal: "0.300003",
        total: "0.300003",
        createdByUserId: fixture.user.id,
        lines: [
          {
            catalogItemId: item.id,
            itemName: "Catalog item",
            description: "Historical description",
            reference: "SKU-1",
            unitPrice: "0.100001",
            quantity: 3,
            lineTotal: "0.300003",
          },
        ],
      },
    });
    if (result.outcome !== "CREATED") throw new Error("Sale was not created");
    await database
      .update(schema.catalogItems)
      .set({ name: "Changed item", price: "99", description: "Changed" })
      .where(eq(schema.catalogItems.id, item.id));
    const historical = await withTenant(
      fixture.organization.id,
      fixture.branch.id,
      (transaction) => getSale(transaction, context, result.sale.id),
    );
    expect(historical?.lines[0]).toMatchObject({
      itemName: "Catalog item",
      description: "Historical description",
      unitPrice: "0.100001",
      lineTotal: "0.300003",
    });
  });

  it("returns the original outcome for duplicate keys and conflicts on changed input", async () => {
    const fixture = await createTenant("Sales idempotency");
    const itemA = await createCatalogItem(fixture.organization.id, fixture.user.id);
    const itemB = await createCatalogItem(fixture.organization.id, fixture.user.id, {
      name: "Second item",
      reference: "SKU-2",
      price: "2",
    });
    await receiveStock(fixture.organization.id, fixture.user.id, fixture.branch.id, itemA.id, 5);
    await receiveStock(fixture.organization.id, fixture.user.id, fixture.branch.id, itemB.id, 5);
    const context = authorizationContext(
      fixture.organization.id,
      fixture.user.id,
      fixture.branch.id,
    );
    const payload = { lines: [{ catalogItemId: itemA.id, quantity: 1 }] };
    const create = () =>
      withTenant(fixture.organization.id, fixture.branch.id, (transaction) =>
        createSale(transaction, context, payload, "stable-key-1"),
      );
    const first = await create();
    const duplicate = await create();
    const changed = await withTenant(
      fixture.organization.id,
      fixture.branch.id,
      (transaction) =>
        createSale(
          transaction,
          context,
          { lines: [{ catalogItemId: itemB.id, quantity: 1 }] },
          "stable-key-1",
        ),
    );
      const [otherCashier] = await database
        .insert(schema.users)
        .values({
          email: `other-cashier-${crypto.randomUUID()}@sales.test`,
          displayName: "Other cashier",
        })
        .returning();
      if (!otherCashier) throw new Error("Second cashier fixture was not created");
      const otherCashierReplay = await withTenant(
        fixture.organization.id,
        fixture.branch.id,
        (transaction) =>
          createSale(
            transaction,
            authorizationContext(
              fixture.organization.id,
              otherCashier.id,
              fixture.branch.id,
            ),
            payload,
            "stable-key-1",
          ),
      );
    expect(first.outcome).toBe("CREATED");
    expect(duplicate).toMatchObject({ outcome: "EXISTING" });
    if (first.outcome !== "CREATED" || duplicate.outcome !== "EXISTING") {
      throw new Error("Idempotent sale result was not returned");
    }
    expect(duplicate.sale.id).toBe(first.sale.id);
    expect(changed).toEqual({ outcome: "IDEMPOTENCY_CONFLICT" });
    expect(otherCashierReplay).toEqual({ outcome: "IDEMPOTENCY_CONFLICT" });
    const rows = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.sales)
      .where(eq(schema.sales.organizationId, fixture.organization.id));
    expect(rows[0]?.count).toBe(1);
  });

  it("rejects unavailable or cross-branch catalog items and mixed currencies", async () => {
    const fixture = await createTenant("Sales catalog checks");
    const inactive = await createCatalogItem(
      fixture.organization.id,
      fixture.user.id,
      { status: "INACTIVE" },
    );
    const foreignBranch = await database
      .insert(schema.branches)
      .values({ organizationId: fixture.organization.id, name: "Other", code: "OTHER" })
      .returning();
    const otherBranchId = foreignBranch[0]!.id;
    const otherBranchItem = await createCatalogItem(
      fixture.organization.id,
      fixture.user.id,
      { branchId: otherBranchId },
    );
    const itemA = await createCatalogItem(fixture.organization.id, fixture.user.id);
    const itemB = await createCatalogItem(fixture.organization.id, fixture.user.id, {
      name: "USD item",
      reference: "USD-1",
      price: "1",
      currency: "USD",
    });
    const context = authorizationContext(
      fixture.organization.id,
      fixture.user.id,
      fixture.branch.id,
    );
    const attempt = (catalogItemId: string, key: string) =>
      withTenant(fixture.organization.id, fixture.branch.id, (transaction) =>
        createSale(
          transaction,
          context,
          { lines: [{ catalogItemId, quantity: 1 }] },
          key,
        ),
      );
    expect((await attempt(inactive.id, "inactive-item")).outcome).toBe(
      "CATALOG_ITEM_UNAVAILABLE",
    );
    expect((await attempt(otherBranchItem.id, "other-branch-item")).outcome).toBe(
      "CATALOG_ITEM_UNAVAILABLE",
    );
    const mixed = await withTenant(
      fixture.organization.id,
      fixture.branch.id,
      (transaction) =>
        createSale(
          transaction,
          context,
          {
            lines: [
              { catalogItemId: itemA.id, quantity: 1 },
              { catalogItemId: itemB.id, quantity: 1 },
            ],
          },
          "mixed-currency",
        ),
    );
    expect(mixed.outcome).toBe("CURRENCY_MISMATCH");
  });

  it("denies cross-tenant reads and prevents mutation", async () => {
    const tenantA = await createTenant("Sales tenant A");
    const tenantB = await createTenant("Sales tenant B");
    const item = await createCatalogItem(tenantA.organization.id, tenantA.user.id);
    await receiveStock(tenantA.organization.id, tenantA.user.id, tenantA.branch.id, item.id, 2);
    const contextA = authorizationContext(
      tenantA.organization.id,
      tenantA.user.id,
      tenantA.branch.id,
    );
    const created = await withTenant(
      tenantA.organization.id,
      tenantA.branch.id,
      (transaction) =>
        createSale(
          transaction,
          contextA,
          { lines: [{ catalogItemId: item.id, quantity: 1 }] },
          "tenant-sale-1",
        ),
    );
    if (created.outcome !== "CREATED") throw new Error("Sale was not created");
    const contextB = authorizationContext(
      tenantB.organization.id,
      tenantB.user.id,
      tenantB.branch.id,
    );
    const hidden = await withTenant(
      tenantB.organization.id,
      tenantB.branch.id,
      async (transaction) => ({
        sale: await getSale(transaction, contextB, created.sale.id),
        page: await listSales(transaction, contextB, { limit: 50, offset: 0 }),
      }),
    );
    expect(hidden).toMatchObject({ sale: undefined, page: { items: [], total: 0 } });
    await expect(
      withTenant(tenantA.organization.id, tenantA.branch.id, (transaction) =>
        transaction
          .update(schema.sales)
          .set({ total: "0" })
          .where(eq(schema.sales.id, created.sale.id)),
      ),
    ).rejects.toThrow();
  });

  it("serializes concurrent identical checkout attempts to one sale", async () => {
    const fixture = await createTenant("Sales concurrent");
    const item = await createCatalogItem(fixture.organization.id, fixture.user.id);
    await receiveStock(fixture.organization.id, fixture.user.id, fixture.branch.id, item.id, 1);
    const context = authorizationContext(
      fixture.organization.id,
      fixture.user.id,
      fixture.branch.id,
    );
    const submit = () =>
      withTenant(fixture.organization.id, fixture.branch.id, (transaction) =>
        createSale(
          transaction,
          context,
          { lines: [{ catalogItemId: item.id, quantity: 1 }] },
          "concurrent-sale-key",
        ),
      );
    const outcomes = await Promise.all([submit(), submit()]);
    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual([
      "CREATED",
      "EXISTING",
    ]);
    const records = await database
      .select({ id: schema.sales.id })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.organizationId, fixture.organization.id),
          eq(schema.sales.idempotencyKey, "concurrent-sale-key"),
        ),
      );
    expect(records).toHaveLength(1);
  });

  it("requires the real sales module entitlement, permission, and assigned branch", async () => {
    const fixture = await createTenant("Sales authorization");
    const [membership] = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: fixture.organization.id,
        userId: fixture.user.id,
        status: "ACTIVE",
        branchAccessMode: "ASSIGNED",
      })
      .returning();
    if (!membership) throw new Error("Sales membership was not created");
    await database.insert(schema.membershipBranches).values({
      organizationId: fixture.organization.id,
      membershipId: membership.id,
      branchId: fixture.branch.id,
    });
    const sessionId = crypto.randomUUID();
    const [session] = await database
      .insert(schema.sessions)
      .values({
        id: sessionId,
        secretHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
        userId: fixture.user.id,
        organizationId: fixture.organization.id,
        branchId: fixture.branch.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!session) throw new Error("Sales session was not created");

    const [salesModule] = await database
      .select({ id: schema.modules.id })
      .from(schema.modules)
      .where(eq(schema.modules.key, "core.sales"))
      .limit(1);
    const [createPermission] = await database
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, "core.sales.sale.create"))
      .limit(1);
    const [readPermission] = await database
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, "core.sales.sale.read"))
      .limit(1);
    if (!salesModule || !createPermission || !readPermission) {
      throw new Error("Sales module or permission metadata was not migrated");
    }

    const authorization = createAuthorizationService(
      database as unknown as Database,
    );
    const context = {
      userId: fixture.user.id,
      sessionId,
      organizationId: fixture.organization.id,
      membershipId: membership.id,
      branchId: fixture.branch.id,
    };
    const metadata = { requestId: crypto.randomUUID() };
    const withoutPermission = await authorization.withPermission(
      context,
      "core.sales.sale.create",
      metadata,
      async () => "allowed",
    );
    expect(withoutPermission.allowed).toBe(false);

    const [subscription] = await database
      .insert(schema.subscriptions)
      .values({
        organizationId: fixture.organization.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!subscription) throw new Error("Sales subscription was not created");
    await database.insert(schema.subscriptionItems).values({
      organizationId: fixture.organization.id,
      subscriptionId: subscription.id,
      moduleId: salesModule.id,
      amount: "0",
      currencyCode: "KES",
    });
    await database.insert(schema.organizationModules).values({
      organizationId: fixture.organization.id,
      moduleId: salesModule.id,
      status: "ENABLED",
      source: "SUBSCRIPTION",
      enabledAt: new Date(),
    });
    const withoutRoleGrant = await authorization.withPermission(
      context,
      "core.sales.sale.create",
      metadata,
      async () => "allowed",
    );
    expect(withoutRoleGrant.allowed).toBe(false);

    const [role] = await database
      .insert(schema.roles)
      .values({
        organizationId: fixture.organization.id,
        name: "Sales operator",
        status: "ACTIVE",
      })
      .returning();
    if (!role) throw new Error("Sales role was not created");
    await database.insert(schema.rolePermissions).values([
      {
        organizationId: fixture.organization.id,
        roleId: role.id,
        permissionId: createPermission.id,
        scopeType: "BRANCH",
      },
      {
        organizationId: fixture.organization.id,
        roleId: role.id,
        permissionId: readPermission.id,
        scopeType: "BRANCH",
      },
    ]);
    await database.insert(schema.membershipRoles).values({
      organizationId: fixture.organization.id,
      membershipId: membership.id,
      roleId: role.id,
    });
    const allowed = await authorization.withPermission(
      context,
      "core.sales.sale.create",
      metadata,
      async (_transaction, resolved) => resolved.branchId,
    );
    expect(allowed).toMatchObject({
      allowed: true,
      value: fixture.branch.id,
      context: { branchId: fixture.branch.id },
    });

    const otherBranch = await database
      .insert(schema.branches)
      .values({
        organizationId: fixture.organization.id,
        name: "Unassigned branch",
        code: "UNASSIGNED",
      })
      .returning();
    const deniedBranch = await authorization.withPermission(
      { ...context, branchId: otherBranch[0]!.id },
      "core.sales.sale.create",
      metadata,
      async () => "allowed",
    );
    expect(deniedBranch.allowed).toBe(false);
  });

  it("keeps sales tables forced-RLS and runtime grants least-privileged", async () => {
    const tableSecurity = await client.query<{
      relname: string;
      owner: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('sales', 'sale_lines')
      ORDER BY c.relname
    `);
    expect(tableSecurity.rows).toHaveLength(2);
    for (const table of tableSecurity.rows) {
      expect(table.owner).not.toBe("onecore_app");
      expect(table.relrowsecurity).toBe(true);
      expect(table.relforcerowsecurity).toBe(true);
    }
    const grants = await client.query<{
      sales_select: boolean;
      sales_insert: boolean;
      sales_update: boolean;
      sales_delete: boolean;
      sales_key_insert: boolean;
      lines_insert: boolean;
      lines_update: boolean;
    }>(`
      SELECT
        has_table_privilege('onecore_app', 'sales', 'SELECT') AS sales_select,
        has_table_privilege('onecore_app', 'sales', 'INSERT') AS sales_insert,
        has_table_privilege('onecore_app', 'sales', 'UPDATE') AS sales_update,
        has_table_privilege('onecore_app', 'sales', 'DELETE') AS sales_delete,
        has_column_privilege('onecore_app', 'sales', 'organization_id', 'INSERT') AS sales_key_insert,
        has_table_privilege('onecore_app', 'sale_lines', 'INSERT') AS lines_insert,
        has_table_privilege('onecore_app', 'sale_lines', 'UPDATE') AS lines_update
    `);
    expect(grants.rows[0]).toEqual({
      sales_select: true,
      sales_insert: false,
      sales_update: false,
      sales_delete: false,
      sales_key_insert: true,
      lines_insert: false,
      lines_update: false,
    });
    const roleFlags = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'onecore_app'
    `);
    expect(roleFlags.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("preserves disabled Sales module and permissions during repeat provisioning", async () => {
    const migration = await readFile(salesMigrationPath, "utf8");
    const provisioningStatements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) =>
        /^INSERT INTO "(?:modules|permissions|module_versions|module_permissions)"/.test(
          statement,
        ),
      );
    expect(provisioningStatements).toHaveLength(4);

    await client.exec(`
      UPDATE modules
      SET name = 'Retired Sales', lifecycle = 'DEPRECATED', is_available = false
      WHERE key = 'core.sales';
      UPDATE permissions
      SET status = 'INACTIVE', description = description || ' (disabled)'
      WHERE module_key = 'core.sales';
      UPDATE module_versions
      SET status = 'DEPRECATED',
        manifest = jsonb_set(manifest, '{lifecycle}', '"DEPRECATED"'::jsonb)
      WHERE module_id = (SELECT id FROM modules WHERE key = 'core.sales');
    `);

    for (const statement of provisioningStatements) {
      await client.exec(statement);
    }
    for (const statement of provisioningStatements) {
      await client.exec(statement);
    }

    const [salesModule] = await database
      .select({ name: schema.modules.name, lifecycle: schema.modules.lifecycle, isAvailable: schema.modules.isAvailable })
      .from(schema.modules)
      .where(eq(schema.modules.key, "core.sales"));
    expect(salesModule).toEqual({
      name: "Retired Sales",
      lifecycle: "DEPRECATED",
      isAvailable: false,
    });

    const permissions = await database
      .select({ key: schema.permissions.key, status: schema.permissions.status, description: schema.permissions.description })
      .from(schema.permissions)
      .where(eq(schema.permissions.moduleKey, "core.sales"));
    expect(permissions).toHaveLength(3);
    expect(permissions.every(({ status }) => status === "INACTIVE")).toBe(true);
    expect(permissions.every(({ description }) => description.endsWith(" (disabled)"))).toBe(true);

    const [moduleVersion] = await database
      .select({ status: schema.moduleVersions.status, manifest: schema.moduleVersions.manifest })
      .from(schema.moduleVersions)
      .where(eq(schema.moduleVersions.moduleId, (await database.select({ id: schema.modules.id }).from(schema.modules).where(eq(schema.modules.key, "core.sales")))[0]!.id));
    expect(moduleVersion?.status).toBe("DEPRECATED");
    expect(moduleVersion?.manifest.lifecycle).toBe("DEPRECATED");
  });
});
