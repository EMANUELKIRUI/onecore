import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@onecore/config";
import { adjustBranchStock } from "@onecore/database";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  OrganizationTransaction,
  ResolvedAuthorizationContext,
} from "@onecore/database";
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

function allowSales(
  grantedPermissions: readonly string[] = [
    "core.sales.sale.create",
    "core.sales.sale.read",
    "core.inventory.stock.reserve",
  ],
): AuthorizationService {
  async function withPermission<T>(
    request: AuthorizationContext | null,
    permissionKey: string,
    _metadata: AuthorizationMetadata,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>> {
    if (!request?.organizationId || !request.membershipId) {
      return {
        allowed: false,
        statusCode: request ? 403 : 401,
        dataScopes: [],
      };
    }
    if (!grantedPermissions.includes(permissionKey)) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }
    const context: ResolvedAuthorizationContext = {
      userId: request.userId,
      sessionId: request.sessionId,
      organizationId: request.organizationId,
      membershipId: request.membershipId,
      branchId: request.branchId,
      branch: request.branchId
        ? { branchId: request.branchId, name: "Sales", code: "SALES" }
        : null,
      branchAccessMode: "ASSIGNED",
      roles: [],
      platformRoles: [],
      permissions: grantedPermissions.map((key) => ({
        key,
        moduleKey: key.startsWith("core.inventory")
          ? "core.inventory"
          : "core.sales",
        scopeType: "BRANCH",
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
      if (context.branchId) {
        await transaction.execute(
          sql`SELECT set_config('app.current_branch_id', ${context.branchId}, true)`,
        );
      }
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
        ? { allowed: true, statusCode: 200, dataScopes: ["BRANCH"] }
        : { allowed: false, statusCode: 401, dataScopes: [] },
    hasPermission: async (context, key) =>
      context !== null && grantedPermissions.includes(key),
    withPermission,
    withAllPermissions: async (context, keys, metadata, operation) =>
      withPermission(context, keys[0] ?? "", metadata, operation),
    withAnyPermission: async (context, keys, metadata, operation) =>
      withPermission(context, keys[0] ?? "", metadata, operation),
  };
}

async function receiveStock(
  organizationId: string,
  userId: string,
  branchId: string,
  catalogItemId: string,
): Promise<void> {
  const result = await database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`SELECT set_config('app.current_user_id', ${userId}, true)`,
    );
    await transaction.execute(
      sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    await transaction.execute(
      sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`,
    );
    return adjustBranchStock(
      transaction as unknown as OrganizationTransaction,
      {
        userId,
        sessionId: crypto.randomUUID(),
        organizationId,
        membershipId: crypto.randomUUID(),
        branchId,
        branch: { branchId, name: "Sales", code: "SALES" },
        branchAccessMode: "ASSIGNED",
        roles: [],
        platformRoles: [],
        permissions: [
          {
            key: "core.inventory.stock.adjust",
            moduleKey: "core.inventory",
            scopeType: "BRANCH",
            scope: {},
          },
        ],
      },
      { catalogItemId, movementType: "RECEIPT", delta: 5 },
      `sales-api-receipt-${crypto.randomUUID()}`,
      crypto.randomUUID(),
    );
  });
  if (result.outcome !== "CREATED") {
    throw new Error("API Sales stock fixture was not created");
  }
}

describe("Sales API", () => {
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

  it("authorizes branch sales, snapshots server prices, deduplicates, and atomically publishes events", async () => {
    const [organization] = await database
      .insert(schema.organizations)
      .values({
        name: "Sales API",
        slug: `sales-api-${crypto.randomUUID()}`,
        industry: "TEST",
        status: "ACTIVE",
      })
      .returning();
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `sales-api-${crypto.randomUUID()}@onecore.test`,
        displayName: "Sales Cashier",
      })
      .returning();
    if (!organization || !user) throw new Error("Sales API fixture missing");
    const [branch] = await database
      .insert(schema.branches)
      .values({ organizationId: organization.id, name: "Sales branch", code: "SALES" })
      .returning();
    if (!branch) throw new Error("Sales branch fixture missing");
    const [item] = await database
      .insert(schema.catalogItems)
      .values({
        organizationId: organization.id,
        branchId: branch.id,
        reference: "SKU-API-1",
        name: "API product",
        description: "Sale-time item description",
        type: "PRODUCT",
        unit: "each",
        price: "12.340001",
        currency: "KES",
        createdByUserId: user.id,
      })
      .returning();
    if (!item) throw new Error("Sales catalog item fixture missing");
    await receiveStock(organization.id, user.id, branch.id, item.id);

    const sessionSecret = "s".repeat(43);
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
    identity.addMembership(user.id, {
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      branchAccessMode: "ASSIGNED",
    });
    identity.addBranchAccess(user.id, organization.id, {
      branchId: branch.id,
      name: branch.name,
      code: branch.code,
    });
    identity.sessions.set(secretHash, {
      id: crypto.randomUUID(),
      secretHash,
      userId: user.id,
      organizationId: organization.id,
      branchId: branch.id,
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
    const baseUrl = `/organizations/${organization.id}/sales`;
    const payload = { lines: [{ catalogItemId: item.id, quantity: 2 }] };
    const headers = { "idempotency-key": "sales-api-request-1" };

    const anonymous = await app.inject({
      method: "POST",
      url: baseUrl,
      headers,
      payload,
    });
    expect(anonymous.statusCode).toBe(401);

    const sameSiteForeignOrigin = await app.inject({
      method: "POST",
      url: baseUrl,
      cookies: { onecore_session: sessionSecret },
      headers: {
        ...headers,
        origin: "https://untrusted.example",
        "sec-fetch-site": "same-site",
      },
      payload,
    });
    expect(sameSiteForeignOrigin.statusCode).toBe(403);

    const forged = await app.inject({
      method: "POST",
      url: baseUrl,
      cookies: { onecore_session: sessionSecret },
      headers,
      payload: { ...payload, total: "0.01", cashierId: crypto.randomUUID() },
    });
    expect(forged.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: baseUrl,
      cookies: { onecore_session: sessionSecret },
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().sale).toMatchObject({
      organizationId: organization.id,
      branchId: branch.id,
      status: "OPEN",
      currency: "KES",
      subtotal: "24.680002",
      total: "24.680002",
      createdByUserId: user.id,
      lines: [
        {
          itemName: "API product",
          description: "Sale-time item description",
          reference: "SKU-API-1",
          unitPrice: "12.340001",
          quantity: 2,
          lineTotal: "24.680002",
        },
      ],
    });
    expect(created.body).not.toContain("idempotencyKey");
    expect(created.body).not.toContain("requestHash");

    const duplicate = await app.inject({
      method: "POST",
      url: baseUrl,
      cookies: { onecore_session: sessionSecret },
      headers,
      payload: payload,
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().sale.id).toBe(created.json().sale.id);

    const conflict = await app.inject({
      method: "POST",
      url: baseUrl,
      cookies: { onecore_session: sessionSecret },
      headers,
      payload: { lines: [{ catalogItemId: item.id, quantity: 3 }] },
    });
    expect(conflict.statusCode).toBe(409);

    const listed = await app.inject({
      method: "GET",
      url: `${baseUrl}?limit=10`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      total: 1,
      items: [{ id: created.json().sale.id }],
    });
    const detail = await app.inject({
      method: "GET",
      url: `${baseUrl}/${created.json().sale.id}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(detail.statusCode).toBe(200);
    const foreign = await app.inject({
      method: "GET",
      url: `/organizations/${crypto.randomUUID()}/sales/${created.json().sale.id}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(foreign.statusCode).toBe(404);

    const readOnlyApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowSales(["core.sales.sale.read"]),
    );
    const deniedCreate = await readOnlyApp.inject({
      method: "POST",
      url: baseUrl,
      cookies: { onecore_session: sessionSecret },
      headers: { "idempotency-key": "sales-api-read-only" },
      payload,
    });
    expect(deniedCreate.statusCode).toBe(403);
    await readOnlyApp.close();

    const eventsBeforeFailure = await database
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(
        eq(schema.outboxEvents.eventType, "SALE_CREATED"),
      );
    expect(eventsBeforeFailure).toHaveLength(1);
    const mutationAudit = await database
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(
        sql`${schema.auditLogs.action} = 'SALE_CREATED' AND ${schema.auditLogs.resourceId} = ${created.json().sale.id}`,
      );
    expect(mutationAudit).toHaveLength(1);

    await client.exec(`
      CREATE FUNCTION fail_sale_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'SALE_CREATED' THEN
          RAISE EXCEPTION 'synthetic outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_sale_outbox_trigger
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION fail_sale_outbox();
    `);
    const failedEvent = await app.inject({
      method: "POST",
      url: baseUrl,
      cookies: { onecore_session: sessionSecret },
      headers: { "idempotency-key": "sales-api-rollback" },
      payload,
    });
    expect(failedEvent.statusCode).toBe(500);
    await client.exec(
      "DROP TRIGGER fail_sale_outbox_trigger ON outbox_events; DROP FUNCTION fail_sale_outbox()",
    );
    const salesAfterFailure = await database
      .select({ id: schema.sales.id })
      .from(schema.sales)
      .where(eq(schema.sales.organizationId, organization.id));
    expect(salesAfterFailure).toHaveLength(1);
    const rollbackAudit = await database
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "SALE_CREATED"));
    expect(rollbackAudit).toHaveLength(1);

    await app.close();
  });
});