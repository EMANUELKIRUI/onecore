import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createDomainEvent,
  moduleManifestSchema,
  parseCustomFieldValue,
  parseFeatureFlagValue,
} from "@onecore/core-domain";
import {
  dispatchOutboxBatch,
  platformWebhookEventHandlers,
  EventDispatchError,
  createPlatformServices,
  createJobHandlerRegistry,
  createJobService,
  createDatabaseRateLimiter,
  createIdentityRepository,
  JobExecutionError,
  recordOutboxEvent,
  type JobHandler,
  type AuthorizationContext,
  type AuthorizationResult,
  type AuthorizationService,
  type EventDispatchOptions,
  type EventHandler,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
} from "../src/index.js";
import {
  evaluateFeatureFlag,
  resolveFeatureFlag,
} from "../src/feature-flags.js";
import { withActiveOrganizationTransaction } from "../src/tenant-context.js";
import type { Database } from "../src/index.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
let client: PGlite;
let database: PgliteDatabase;
let initialApplicationPrivileges = new Set<string>();
let initialApplicationColumnPrivileges = new Set<string>();
let initialApplicationSchemaCreate = false;

async function asTenant<T>(
  organizationId: string,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return client.transaction(async (transaction) => {
    await transaction.exec("SET LOCAL ROLE onecore_app");
    await transaction.query(
      "SELECT set_config('app.current_organization_id', $1, true)",
      [organizationId],
    );
    return operation(transaction);
  });
}

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
  if (!organization) throw new Error("Test organization was not created");
  return organization;
}

function eventWorkerContext(
  organizationId: string,
  userId: string,
): ResolvedAuthorizationContext {
  return {
    userId,
    sessionId: crypto.randomUUID(),
    organizationId,
    membershipId: crypto.randomUUID(),
    branchId: null,
    branch: null,
    branchAccessMode: "ALL",
    roles: [],
    platformRoles: [],
    permissions: [],
  };
}

function platformTestAuthorization(): AuthorizationService {
  async function run<T>(
    context: AuthorizationContext | null,
    permissionKeys: readonly string[],
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>> {
    if (!context?.organizationId || !context.membershipId) {
      return { allowed: false, statusCode: 401, dataScopes: [] };
    }
    const resolved: ResolvedAuthorizationContext = {
      userId: context.userId,
      sessionId: context.sessionId,
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      branchId: context.branchId,
      branch: null,
      branchAccessMode: "ALL",
      roles: [],
      platformRoles: [],
      permissions: permissionKeys.map((key) => {
        const segments = key.split(".");
        return {
          key,
          moduleKey: segments.slice(0, -2).join("."),
          scopeType: "ORGANIZATION" as const,
          scope: {},
        };
      }),
    };
    const value = await database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
      await transaction.execute(
        sql`SELECT set_config('app.current_user_id', ${resolved.userId}, true)`,
      );
      await transaction.execute(
        sql`SELECT set_config('app.current_organization_id', ${resolved.organizationId}, true)`,
      );
      if (resolved.branchId) {
        await transaction.execute(
          sql`SELECT set_config('app.current_branch_id', ${resolved.branchId}, true)`,
        );
      }
      return operation(
        transaction as unknown as OrganizationTransaction,
        resolved,
      );
    });
    return { allowed: true, value, context: resolved };
  }

  return {
    authorize: async (context) =>
      context
        ? {
            allowed: true,
            statusCode: 200,
            context: {
              ...eventWorkerContext(
                context.organizationId ?? crypto.randomUUID(),
                context.userId,
              ),
              membershipId: context.membershipId ?? crypto.randomUUID(),
              branchId: context.branchId,
            },
            dataScopes: [],
          }
        : { allowed: false, statusCode: 401, dataScopes: [] },
    hasPermission: async (context) => context !== null,
    withPermission: (context, permission, _metadata, operation) =>
      run(context, [permission], operation),
    withAllPermissions: (context, permissions, _metadata, operation) =>
      run(context, permissions, operation),
    withAnyPermission: (context, permissions, _metadata, operation) =>
      run(context, permissions, operation),
  };
}

function testAuthorizationContext(
  userId: string,
  organizationId: string,
  membershipId: string,
  branchId: string | null = null,
): AuthorizationContext {
  return {
    userId,
    sessionId: crypto.randomUUID(),
    organizationId,
    membershipId,
    branchId,
  };
}

async function dispatchAsTenant(
  organizationId: string,
  context: ResolvedAuthorizationContext,
  handlers: readonly EventHandler[],
  options: EventDispatchOptions = {},
) {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    if (context.branchId) {
      await transaction.execute(
        sql`SELECT set_config('app.current_branch_id', ${context.branchId}, true)`,
      );
    }
    return dispatchOutboxBatch(
      transaction as unknown as OrganizationTransaction,
      context,
      handlers,
      options,
    );
  });
}

describe("PostgreSQL persistence foundation", () => {
  beforeAll(async () => {
    client = new PGlite();
    database = drizzle({ client });
    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    `);
    await applyTestMigrations(client, migrationsDirectory);

    const grants = await client.query<{
      table_name: string;
      privilege_type: string;
    }>(`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'onecore_app'
    `);
    initialApplicationPrivileges = new Set(
      grants.rows.map(
        ({ table_name, privilege_type }) => `${table_name}:${privilege_type}`,
      ),
    );
    const columnGrants = await client.query<{
      table_name: string;
      column_name: string;
      privilege_type: string;
    }>(`
      SELECT table_name, column_name, privilege_type
      FROM information_schema.role_column_grants
      WHERE grantee = 'onecore_app'
    `);
    initialApplicationColumnPrivileges = new Set(
      columnGrants.rows.map(
        ({ table_name, column_name, privilege_type }) =>
          `${table_name}:${privilege_type}:${column_name}`,
      ),
    );
    const schemaPrivileges = await client.query<{ can_create: boolean }>(
      `SELECT has_schema_privilege('onecore_app', 'public', 'CREATE') AS can_create`,
    );
    initialApplicationSchemaCreate =
      schemaPrivileges.rows[0]?.can_create ?? true;

    await client.exec(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onecore_app;
    `);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("migrates only the documented least-privilege runtime table grants", async () => {
    const required = [
      "users:SELECT",
      "sessions:SELECT",
      "organization_memberships:SELECT",
      "branches:SELECT",
      "roles:SELECT",
      "permissions:SELECT",
      "feature_flags:SELECT",
      "feature_flag_assignments:INSERT",
      "organization_settings:UPDATE",
      "jobs:SELECT",
      "rate_limit_buckets:INSERT",
      "rate_limit_buckets:UPDATE",
    ];
    for (const privilege of required) {
      expect(initialApplicationPrivileges.has(privilege), privilege).toBe(true);
    }

    const requiredColumnPrivileges = [
      "organizations:INSERT:id",
      "organizations:INSERT:name",
      "organizations:INSERT:slug",
      "organizations:INSERT:industry",
      "organizations:INSERT:status",
      "organizations:INSERT:deployment_type",
      "users:INSERT:id",
      "users:INSERT:email",
      "users:INSERT:display_name",
      "users:INSERT:status",
      "users:INSERT:password_hash",
      "organization_memberships:INSERT:id",
      "organization_memberships:INSERT:organization_id",
      "organization_memberships:INSERT:user_id",
      "organization_memberships:INSERT:status",
      "organization_memberships:INSERT:branch_access_mode",
      "outbox_events:INSERT:id",
      "outbox_events:INSERT:event_type",
      "outbox_events:INSERT:aggregate_type",
      "outbox_events:INSERT:aggregate_id",
      "outbox_events:INSERT:organization_id",
      "outbox_events:INSERT:branch_id",
      "outbox_events:INSERT:actor_user_id",
      "outbox_events:INSERT:correlation_id",
      "outbox_events:INSERT:causation_id",
      "outbox_events:INSERT:occurred_at",
      "outbox_events:INSERT:payload",
      "outbox_events:INSERT:metadata",
      "outbox_events:INSERT:version",
      "outbox_events:INSERT:delivery_status",
      "outbox_events:INSERT:next_attempt_at",
      "outbox_events:SELECT:id",
      "outbox_events:SELECT:event_type",
      "outbox_events:SELECT:aggregate_type",
      "outbox_events:SELECT:aggregate_id",
      "outbox_events:SELECT:organization_id",
      "outbox_events:SELECT:branch_id",
      "outbox_events:SELECT:actor_user_id",
      "outbox_events:SELECT:correlation_id",
      "outbox_events:SELECT:causation_id",
      "outbox_events:SELECT:occurred_at",
      "outbox_events:SELECT:payload",
      "outbox_events:SELECT:metadata",
      "outbox_events:SELECT:version",
      "users:UPDATE:status",
      "users:UPDATE:failed_login_attempts",
      "users:UPDATE:failed_login_window_started_at",
      "users:UPDATE:locked_until",
      "users:UPDATE:last_login_at",
      "users:UPDATE:updated_at",
      "organizations:UPDATE:status",
      "sessions:INSERT:secret_hash",
      "sessions:INSERT:user_id",
      "sessions:INSERT:organization_id",
      "sessions:INSERT:branch_id",
      "sessions:INSERT:created_at",
      "sessions:INSERT:expires_at",
      "sessions:INSERT:last_used_at",
      "sessions:INSERT:ip_address",
      "sessions:INSERT:user_agent",
      "sessions:UPDATE:organization_id",
      "sessions:UPDATE:branch_id",
      "sessions:UPDATE:last_used_at",
      "sessions:UPDATE:revoked_at",
      "organization_memberships:UPDATE:updated_at",
      "organizations:UPDATE:updated_at",
      "branches:UPDATE:updated_at",
      "membership_branches:UPDATE:created_at",
      "roles:INSERT:organization_id",
      "roles:INSERT:name",
      "roles:INSERT:description",
      "roles:INSERT:is_system",
      "roles:UPDATE:name",
      "roles:UPDATE:description",
      "roles:UPDATE:status",
      "roles:UPDATE:updated_at",
    ];
    for (const privilege of requiredColumnPrivileges) {
      expect(initialApplicationColumnPrivileges.has(privilege), privilege).toBe(
        true,
      );
    }
    const forbiddenRoleInsertColumns = [
      "roles:INSERT:id",
      "roles:INSERT:status",
      "roles:INSERT:created_at",
      "roles:INSERT:updated_at",
    ];
    for (const privilege of forbiddenRoleInsertColumns) {
      expect(initialApplicationColumnPrivileges.has(privilege), privilege).toBe(
        false,
      );
    }
    expect(
      initialApplicationColumnPrivileges.has(
        "outbox_events:SELECT:delivery_status",
      ),
    ).toBe(false);
    expect(
      initialApplicationColumnPrivileges.has("outbox_events:SELECT:attempts"),
    ).toBe(false);

    const forbidden = [
      "users:UPDATE",
      "organizations:UPDATE",
      "users:DELETE",
      "users:INSERT",
      "sessions:INSERT",
      "sessions:UPDATE",
      "organization_memberships:UPDATE",
      "organization_memberships:INSERT",
      "outbox_events:INSERT",
      "branches:UPDATE",
      "membership_branches:UPDATE",
      "roles:INSERT",
      "roles:UPDATE",
      "audit_logs:SELECT",
      "audit_logs:DELETE",
      "custom_field_values:SELECT",
      "custom_field_values:INSERT",
    ];
    for (const privilege of forbidden) {
      expect(initialApplicationPrivileges.has(privilege), privilege).toBe(
        false,
      );
    }
    expect(initialApplicationSchemaCreate).toBe(false);

    const applicationInsertPolicy = await client.query<{
      permissive: string;
      cmd: string;
      with_check: string | null;
    }>(`
      SELECT permissive, cmd, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'organizations'
        AND policyname = 'organizations_platform_superadmin_or_application_insert'
    `);
    expect(applicationInsertPolicy.rows).toHaveLength(1);
    expect(applicationInsertPolicy.rows[0]).toMatchObject({
      permissive: "RESTRICTIVE",
      cmd: "INSERT",
    });
    expect(applicationInsertPolicy.rows[0]?.with_check).toContain("PENDING");
    expect(applicationInsertPolicy.rows[0]?.with_check).toContain(
      "organization_application_submission",
    );
  });

  it("keeps lifecycle grants column-scoped and system-role provisioning restrictive", async () => {
    expect(initialApplicationPrivileges.has("organizations:UPDATE")).toBe(
      false,
    );
    expect(
      initialApplicationColumnPrivileges.has("organizations:UPDATE:status"),
    ).toBe(true);

    const policies = await client.query<{
      policyname: string;
      permissive: string;
      cmd: string;
      roles: string[];
      with_check: string | null;
    }>(`
      SELECT policyname, permissive, cmd, roles, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'roles'
        AND policyname = 'roles_system_templates_platform_provisioning'
    `);
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({
      permissive: "RESTRICTIVE",
      cmd: "INSERT",
      roles: ["onecore_app"],
    });
    expect(policies.rows[0]?.with_check).toContain("SUPERADMIN");
  });

  it("migrates a clean database and keeps organizations and branches tenant-isolated", async () => {
    const organizationA = await createOrganization("Tenant A");
    const organizationB = await createOrganization("Tenant B");
    await database.insert(schema.branches).values([
      {
        organizationId: organizationA.id,
        name: "A Main",
        code: "A-MAIN",
      },
      {
        organizationId: organizationB.id,
        name: "B Main",
        code: "B-MAIN",
      },
    ]);

    const visibleBranches = await asTenant(organizationA.id, (transaction) =>
      transaction.query<{ code: string }>(
        "SELECT code FROM branches ORDER BY code",
      ),
    );
    expect(visibleBranches.rows.map((branch) => branch.code)).toEqual([
      "A-MAIN",
    ]);

    const crossTenantOperations = await asTenant(
      organizationA.id,
      async (transaction) => {
        const read = await transaction.query(
          "SELECT id FROM branches WHERE organization_id = $1",
          [organizationB.id],
        );
        const update = await transaction.query(
          "UPDATE branches SET name = 'tampered' WHERE organization_id = $1 RETURNING id",
          [organizationB.id],
        );
        const deleted = await transaction.query(
          "DELETE FROM branches WHERE organization_id = $1 RETURNING id",
          [organizationB.id],
        );
        return { read, update, deleted };
      },
    );
    expect(crossTenantOperations.read.rows).toEqual([]);
    expect(crossTenantOperations.update.rows).toEqual([]);
    expect(crossTenantOperations.deleted.rows).toEqual([]);
    const tenantBBranch = await asTenant(organizationB.id, (transaction) =>
      transaction.query<{ name: string }>(
        "SELECT name FROM branches WHERE code = 'B-MAIN'",
      ),
    );
    expect(tenantBBranch.rows).toEqual([{ name: "B Main" }]);

    const noContextRows = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      const read = await transaction.query("SELECT id FROM branches");
      const update = await transaction.query(
        "UPDATE branches SET name = 'missing-context' RETURNING id",
      );
      const deleted = await transaction.query(
        "DELETE FROM branches RETURNING id",
      );
      return { read, update, deleted };
    });

    expect(noContextRows.read.rows).toEqual([]);
    expect(noContextRows.update.rows).toEqual([]);
    expect(noContextRows.deleted.rows).toEqual([]);
    await expect(
      client.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "INSERT INTO branches (organization_id, name, code) VALUES ($1, $2, $3)",
          [organizationA.id, "Missing Context", "NO-CONTEXT"],
        );
      }),
    ).rejects.toThrow();

    await expect(
      asTenant(organizationA.id, (transaction) =>
        transaction.query(
          "INSERT INTO branches (organization_id, name, code) VALUES ($1, $2, $3)",
          [organizationB.id, "Cross Tenant", "CROSS"],
        ),
      ),
    ).rejects.toThrow();
  });

  it("isolates organization module entitlements under forced RLS", async () => {
    const organizationA = await createOrganization("Module Tenant A");
    const organizationB = await createOrganization("Module Tenant B");
    const moduleKey = `core.test.m${crypto.randomUUID().replaceAll("-", "")}`;
    const manifest = moduleManifestSchema.parse({
      name: moduleKey,
      version: "1.0.0",
      displayName: "Module Tenant Isolation Test",
      dependencies: [],
      permissions: [],
      features: [],
      lifecycle: "AVAILABLE",
    });
    const [module] = await database
      .insert(schema.modules)
      .values({
        key: moduleKey,
        name: manifest.displayName,
        lifecycle: "AVAILABLE",
        isAvailable: true,
      })
      .returning();
    if (!module) throw new Error("Test module was not created");
    await database.insert(schema.moduleVersions).values({
      moduleId: module.id,
      version: manifest.version,
      status: manifest.lifecycle,
      manifest,
    });
    await database.insert(schema.organizationModules).values([
      {
        organizationId: organizationA.id,
        moduleId: module.id,
        status: "ENABLED",
        source: "MANUAL",
      },
      {
        organizationId: organizationB.id,
        moduleId: module.id,
        status: "ENABLED",
        source: "MANUAL",
      },
    ]);

    const tenantAEntitlements = await asTenant(
      organizationA.id,
      (transaction) =>
        transaction.query<{ organization_id: string; status: string }>(
          "SELECT organization_id, status FROM organization_modules",
        ),
    );
    expect(tenantAEntitlements.rows).toEqual([
      { organization_id: organizationA.id, status: "ENABLED" },
    ]);

    const crossTenantChanges = await asTenant(
      organizationA.id,
      async (transaction) => ({
        update: await transaction.query(
          "UPDATE organization_modules SET status = 'DISABLED' WHERE organization_id = $1 RETURNING id",
          [organizationB.id],
        ),
        delete: await transaction.query(
          "DELETE FROM organization_modules WHERE organization_id = $1 RETURNING id",
          [organizationB.id],
        ),
      }),
    );
    expect(crossTenantChanges.update.rows).toEqual([]);
    expect(crossTenantChanges.delete.rows).toEqual([]);
    await expect(
      asTenant(organizationA.id, (transaction) =>
        transaction.query(
          "INSERT INTO organization_modules (organization_id, module_id, status, source) VALUES ($1, $2, 'ENABLED', 'MANUAL')",
          [organizationB.id, module.id],
        ),
      ),
    ).rejects.toThrow();
    const missingContext = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      return transaction.query("SELECT id FROM organization_modules");
    });
    expect(missingContext.rows).toEqual([]);
  });

  it("forces RLS on every organization-scoped table and keeps the API role non-bypass", async () => {
    const tenantTables = await client.query<{
      name: string;
      rls: boolean;
      forced: boolean;
      owner: string;
    }>(`
    SELECT c.relname AS name, c.relrowsecurity AS rls,
           c.relforcerowsecurity AS forced, owner.rolname AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner ON owner.oid = c.relowner
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND EXISTS (
        SELECT 1 FROM information_schema.columns column_info
        WHERE column_info.table_schema = n.nspname
          AND column_info.table_name = c.relname
          AND column_info.column_name = 'organization_id'
      )
    `);
    expect(tenantTables.rows.length).toBeGreaterThan(0);
    for (const table of tenantTables.rows) {
      expect(table.rls, `${table.name} RLS enabled`).toBe(true);
      expect(table.forced, `${table.name} RLS forced`).toBe(true);
      expect(table.owner, `${table.name} not API-owned`).not.toBe(
        "onecore_app",
      );
    }

    const [applicationRole] = await client
      .query<{
        superuser: boolean;
        bypassRls: boolean;
        createRoles: boolean;
        createDatabases: boolean;
      }>(
        `SELECT rolsuper AS superuser,
                rolbypassrls AS "bypassRls",
                rolcreaterole AS "createRoles",
                rolcreatedb AS "createDatabases"
         FROM pg_roles WHERE rolname = 'onecore_app'`,
      )
      .then((result) => result.rows);
    expect(applicationRole).toEqual({
      superuser: false,
      bypassRls: false,
      createRoles: false,
      createDatabases: false,
    });
  });

  it("enforces atomic database-backed rate limits with tenant-separated keys", async () => {
    const rateLimiter = createDatabaseRateLimiter(
      database as unknown as Database,
    );
    const now = new Date("2026-01-01T00:00:00.000Z");
    const base = {
      scope: "authentication.login",
      subject: "test-client",
      requestId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      limit: 2,
      windowMs: 60_000,
      now,
    };
    expect(await rateLimiter.consume(base)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(await rateLimiter.consume(base)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(await rateLimiter.consume(base)).toMatchObject({
      allowed: false,
      remaining: 0,
    });
    const rateLimitEvents = await database
      .select({
        id: schema.auditLogs.id,
        requestMetadata: schema.auditLogs.requestMetadata,
      })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "security.rate_limit.triggered"));
    expect(rateLimitEvents).toHaveLength(1);
    expect(rateLimitEvents[0]?.requestMetadata).toMatchObject({
      requestId: base.requestId,
      correlationId: base.correlationId,
      reason: "limit_exceeded",
    });
    expect(JSON.stringify(rateLimitEvents[0]?.requestMetadata)).not.toContain(
      base.subject,
    );
    expect(
      await rateLimiter.consume({
        ...base,
        now: new Date(now.getTime() + 60_001),
      }),
    ).toMatchObject({ allowed: true, remaining: 1 });

    const organizationA = await createOrganization("Rate Limit Tenant A");
    const organizationB = await createOrganization("Rate Limit Tenant B");
    const tenantA = { ...base, organizationId: organizationA.id };
    const tenantB = { ...base, organizationId: organizationB.id };
    expect(await rateLimiter.consume(tenantA)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(await rateLimiter.consume(tenantB)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(await rateLimiter.consume(tenantA)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(await rateLimiter.consume(tenantB)).toMatchObject({
      allowed: true,
      remaining: 0,
    });

    const [branchA, branchB] = await database
      .insert(schema.branches)
      .values([
        {
          organizationId: organizationA.id,
          name: "Rate Branch A",
          code: "R-A",
        },
        {
          organizationId: organizationA.id,
          name: "Rate Branch B",
          code: "R-B",
        },
      ])
      .returning({ id: schema.branches.id });
    if (!branchA || !branchB) throw new Error("Rate limit branches missing");
    const branchScoped = { ...tenantA, subject: "branch-client" };
    expect(
      await rateLimiter.consume({ ...branchScoped, branchId: branchA.id }),
    ).toMatchObject({ allowed: true, remaining: 1 });
    expect(
      await rateLimiter.consume({ ...branchScoped, branchId: branchA.id }),
    ).toMatchObject({ allowed: true, remaining: 0 });
    expect(
      await rateLimiter.consume({ ...branchScoped, branchId: branchB.id }),
    ).toMatchObject({ allowed: true, remaining: 1 });
    await expect(
      rateLimiter.consume({
        ...base,
        subject: "branch-client-without-tenant",
        branchId: branchA.id,
      }),
    ).rejects.toThrow(/branch requires an organization/i);

    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () =>
        rateLimiter.consume({
          ...base,
          scope: "test.concurrent",
          subject: "parallel-client",
        }),
      ),
    );
    expect(concurrent.filter(({ allowed }) => allowed)).toHaveLength(2);
    expect(concurrent.filter(({ allowed }) => !allowed)).toHaveLength(4);
  });

  it("keeps tenant rate-limit buckets inaccessible without matching RLS context", async () => {
    const organizationA = await createOrganization("Rate RLS Tenant A");
    const organizationB = await createOrganization("Rate RLS Tenant B");
    const [branchA, branchB] = await database
      .insert(schema.branches)
      .values([
        { organizationId: organizationA.id, name: "RLS Branch A", code: "L-A" },
        { organizationId: organizationA.id, name: "RLS Branch B", code: "L-B" },
      ])
      .returning({ id: schema.branches.id });
    if (!branchA || !branchB) throw new Error("Rate limit branches missing");
    const rateLimiter = createDatabaseRateLimiter(
      database as unknown as Database,
    );
    const branchInput = {
      scope: "test.branch",
      subject: "branch-client",
      organizationId: organizationA.id,
      limit: 3,
      windowMs: 60_000,
    };
    await rateLimiter.consume({ ...branchInput, branchId: branchA.id });
    await rateLimiter.consume({ ...branchInput, branchId: branchB.id });
    const branchBKey = (
      await database
        .select({ keyHash: schema.rateLimitBuckets.keyHash })
        .from(schema.rateLimitBuckets)
        .where(eq(schema.rateLimitBuckets.branchId, branchB.id))
        .limit(1)
    )[0]?.keyHash;
    if (!branchBKey) throw new Error("Branch rate-limit bucket missing");
    const branchIsolation = await asTenant(
      organizationA.id,
      async (transaction) => {
        await transaction.query(
          "SELECT set_config('app.current_branch_id', $1, true)",
          [branchA.id],
        );
        const read = await transaction.query(
          'SELECT "key_hash" FROM "rate_limit_buckets" WHERE "key_hash" = $1',
          [branchBKey],
        );
        const update = await transaction.query(
          'UPDATE "rate_limit_buckets" SET "hit_count" = 2 WHERE "key_hash" = $1 RETURNING "key_hash"',
          [branchBKey],
        );
        return { read, update };
      },
    );
    expect(branchIsolation.read.rows).toEqual([]);
    expect(branchIsolation.update.rows).toEqual([]);

    const foreignKey = createHash("sha256")
      .update(crypto.randomUUID())
      .digest("hex");
    await database.insert(schema.rateLimitBuckets).values({
      keyHash: foreignKey,
      organizationId: organizationB.id,
      hitCount: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const foreignRead = await asTenant(organizationA.id, async (transaction) =>
      transaction.query(
        'SELECT "key_hash" FROM "rate_limit_buckets" WHERE "key_hash" = $1',
        [foreignKey],
      ),
    );
    expect(foreignRead.rows).toEqual([]);

    const missingContextRead = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      return transaction.query(
        'SELECT "key_hash" FROM "rate_limit_buckets" WHERE "key_hash" = $1',
        [foreignKey],
      );
    });
    expect(missingContextRead.rows).toEqual([]);

    await expect(
      client.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "SELECT set_config('app.current_organization_id', $1, true)",
          [organizationA.id],
        );
        await transaction.query(
          `INSERT INTO "rate_limit_buckets" ("key_hash", "organization_id", "hit_count", "expires_at")
           VALUES ($1, $2, 1, $3)`,
          [
            createHash("sha256").update(crypto.randomUUID()).digest("hex"),
            organizationB.id,
            new Date(Date.now() + 60_000),
          ],
        );
      }),
    ).rejects.toThrow();

    await expect(
      client.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          `INSERT INTO "rate_limit_buckets" ("key_hash", "organization_id", "hit_count", "expires_at")
           VALUES ($1, $2, 1, $3)`,
          [
            createHash("sha256").update(crypto.randomUUID()).digest("hex"),
            organizationA.id,
            new Date(Date.now() + 60_000),
          ],
        );
      }),
    ).rejects.toThrow();
  });

  it("does not leak transaction-local organization context across concurrent requests", async () => {
    const organizationA = await createOrganization("Concurrent Context A");
    const organizationB = await createOrganization("Concurrent Context B");
    await database.insert(schema.branches).values([
      {
        organizationId: organizationA.id,
        name: "Concurrent A",
        code: "CONCURRENT-A",
      },
      {
        organizationId: organizationB.id,
        name: "Concurrent B",
        code: "CONCURRENT-B",
      },
    ]);

    const readTenant = (organizationId: string) =>
      client.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "SELECT set_config('app.current_organization_id', $1, true)",
          [organizationId],
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await transaction.query<{ code: string }>(
          "SELECT code FROM branches WHERE code LIKE 'CONCURRENT-%' ORDER BY code",
        );
        return result.rows.map(({ code }) => code);
      });

    const [tenantA, tenantB] = await Promise.all([
      readTenant(organizationA.id),
      readTenant(organizationB.id),
    ]);
    expect(tenantA).toEqual(["CONCURRENT-A"]);
    expect(tenantB).toEqual(["CONCURRENT-B"]);
  });

  it("associates users with multiple organizations and enforces same-tenant roles and branches", async () => {
    const organizationA = await createOrganization("Membership A");
    const organizationB = await createOrganization("Membership B");
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `multi-org-${crypto.randomUUID()}@example.test`,
        displayName: "Multi-organization User",
      })
      .returning();
    if (!user) throw new Error("Test user was not created");

    const [membershipA] = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organizationA.id,
        userId: user.id,
        status: "ACTIVE",
      })
      .returning();
    await database.insert(schema.organizationMemberships).values({
      organizationId: organizationB.id,
      userId: user.id,
      status: "ACTIVE",
    });
    if (!membershipA) throw new Error("Test membership was not created");

    const [branchA] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationA.id,
        name: "Scoped Branch",
        code: "SCOPE",
      })
      .returning();
    const [branchB] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationB.id,
        name: "Other Tenant Branch",
        code: "OTHER",
      })
      .returning();
    const [roleA] = await database
      .insert(schema.roles)
      .values({ organizationId: organizationA.id, name: "Branch Manager" })
      .returning();
    const [roleB] = await database
      .insert(schema.roles)
      .values({ organizationId: organizationB.id, name: "Branch Manager" })
      .returning();
    if (!branchA || !branchB || !roleA || !roleB) {
      throw new Error("Test branch or role was not created");
    }

    await database.insert(schema.membershipBranches).values({
      organizationId: organizationA.id,
      membershipId: membershipA.id,
      branchId: branchA.id,
    });
    await database.insert(schema.membershipRoles).values({
      organizationId: organizationA.id,
      membershipId: membershipA.id,
      roleId: roleA.id,
    });

    const permissionAction = `p${crypto.randomUUID().replaceAll("-", "")}`;
    const [permission] = await database
      .insert(schema.permissions)
      .values({
        key: `test.permission.${permissionAction}`,
        moduleKey: "test",
        resourceKey: "permission",
        actionKey: permissionAction,
        description: "Test permission.",
      })
      .returning();
    if (!permission) throw new Error("Test permission was not created");
    await database.insert(schema.rolePermissions).values({
      organizationId: organizationA.id,
      roleId: roleA.id,
      permissionId: permission.id,
    });

    const assignedBranches = await database
      .select({ branchId: schema.membershipBranches.branchId })
      .from(schema.membershipBranches)
      .where(eq(schema.membershipBranches.membershipId, membershipA.id));
    expect(assignedBranches).toEqual([{ branchId: branchA.id }]);

    const tenantRoleIds = await asTenant(organizationA.id, (transaction) =>
      transaction.query<{ id: string }>("SELECT id FROM roles ORDER BY id"),
    );
    expect(tenantRoleIds.rows.map(({ id }) => id)).toEqual([roleA.id]);
    const crossTenantRoleMutation = await asTenant(
      organizationA.id,
      (transaction) =>
        transaction.query<{ id: string }>(
          "UPDATE roles SET name = 'Unauthorized' WHERE id = $1 RETURNING id",
          [roleB.id],
        ),
    );
    expect(crossTenantRoleMutation.rows).toEqual([]);
    const tenantRolePermissionIds = await asTenant(
      organizationA.id,
      (transaction) =>
        transaction.query<{ role_id: string }>(
          "SELECT role_id FROM role_permissions ORDER BY role_id",
        ),
    );
    expect(tenantRolePermissionIds.rows).toEqual([{ role_id: roleA.id }]);

    const missingTenantRoleAccess = await client.transaction(
      async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        return transaction.query<{ id: string }>("SELECT id FROM roles");
      },
    );
    expect(missingTenantRoleAccess.rows).toEqual([]);

    await expect(
      database.insert(schema.membershipBranches).values({
        organizationId: organizationA.id,
        membershipId: membershipA.id,
        branchId: branchB.id,
      }),
    ).rejects.toThrow();

    await expect(
      database.insert(schema.membershipRoles).values({
        organizationId: organizationA.id,
        membershipId: membershipA.id,
        roleId: roleB.id,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(schema.rolePermissions).values({
        organizationId: organizationA.id,
        roleId: roleB.id,
        permissionId: permission.id,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(schema.branches).values({
        organizationId: organizationA.id,
        name: "Duplicate Branch Code",
        code: "SCOPE",
      }),
    ).rejects.toThrow();

    const memberships = await database
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    expect(memberships).toHaveLength(2);
  });

  it("constrains selected session branches to the session organization", async () => {
    const organizationA = await createOrganization("Session Branch A");
    const organizationB = await createOrganization("Session Branch B");
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `branch-session-${crypto.randomUUID()}@example.test`,
        displayName: "Branch Session User",
      })
      .returning();
    if (!user) throw new Error("Branch session user was not created");

    const [membership] = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organizationA.id,
        userId: user.id,
        status: "ACTIVE",
        branchAccessMode: "ASSIGNED",
      })
      .returning();
    if (!membership) throw new Error("Branch membership was not created");

    const [branchA] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationA.id,
        name: "Assigned Branch",
        code: "ASSIGNED",
      })
      .returning();
    const [branchB] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationB.id,
        name: "Foreign Branch",
        code: "FOREIGN",
      })
      .returning();
    if (!branchA || !branchB) throw new Error("Test branches were not created");

    await database.insert(schema.membershipBranches).values({
      organizationId: organizationA.id,
      membershipId: membership.id,
      branchId: branchA.id,
    });
    const secretHash = createHash("sha256")
      .update(crypto.randomUUID())
      .digest("hex");
    await expect(
      database.insert(schema.sessions).values({
        secretHash,
        userId: user.id,
        branchId: branchA.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(schema.sessions).values({
        secretHash,
        userId: user.id,
        organizationId: organizationA.id,
        branchId: branchB.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();

    const [session] = await database
      .insert(schema.sessions)
      .values({
        secretHash: createHash("sha256")
          .update(crypto.randomUUID())
          .digest("hex"),
        userId: user.id,
        organizationId: organizationA.id,
        branchId: branchA.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    expect(session?.branchId).toBe(branchA.id);
  });

  it("scopes identity, sessions, and tenantless authentication audit under RLS", async () => {
    const organizationA = await createOrganization("Identity Scope A");
    const organizationB = await createOrganization("Identity Scope B");
    const organizationC = await createOrganization("Identity Scope C");
    const organizationD = await createOrganization("Identity Scope D");
    const email = `identity-${crypto.randomUUID()}@example.test`;
    const [user] = await database
      .insert(schema.users)
      .values({
        email,
        displayName: "Identity Scope User",
        passwordHash: "$argon2id$test-hash",
      })
      .returning();
    if (!user) throw new Error("Identity user was not created");

    await database.insert(schema.organizationMemberships).values([
      {
        organizationId: organizationA.id,
        userId: user.id,
        status: "ACTIVE",
      },
      {
        organizationId: organizationB.id,
        userId: user.id,
        status: "ACTIVE",
      },
      {
        organizationId: organizationC.id,
        userId: user.id,
        status: "SUSPENDED",
      },
    ]);

    const [session] = await database
      .insert(schema.sessions)
      .values({
        secretHash: createHash("sha256")
          .update(crypto.randomUUID())
          .digest("hex"),
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!session) throw new Error("Identity session was not created");

    await expect(
      database.insert(schema.sessions).values({
        secretHash: createHash("sha256")
          .update(crypto.randomUUID())
          .digest("hex"),
        userId: user.id,
        organizationId: organizationD.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();

    const memberships = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      await transaction.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [user.id],
      );
      const visibleMemberships = await transaction.query<{
        organization_id: string;
      }>(
        "SELECT organization_id FROM organization_memberships WHERE status = 'ACTIVE' ORDER BY organization_id",
      );
      const visibleOrganizations = await transaction.query<{ id: string }>(
        "SELECT id FROM organizations ORDER BY id",
      );
      const visibleUsers = await transaction.query<{ id: string }>(
        "SELECT id FROM users",
      );
      return { visibleMemberships, visibleOrganizations, visibleUsers };
    });

    expect(
      memberships.visibleMemberships.rows.map((row) => row.organization_id),
    ).toEqual([organizationA.id, organizationB.id].sort());
    expect(memberships.visibleOrganizations.rows.map((row) => row.id)).toEqual(
      [organizationA.id, organizationB.id].sort(),
    );
    expect(memberships.visibleUsers.rows).toEqual([{ id: user.id }]);

    const unauthorizedOrganizationMemberships = await asTenant(
      organizationA.id,
      (transaction) =>
        transaction.query(
          "SELECT id FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
          [organizationB.id, user.id],
        ),
    );
    expect(unauthorizedOrganizationMemberships.rows).toEqual([]);

    const visibleSession = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      await transaction.query(
        "SELECT set_config('app.current_session_hash', $1, true)",
        [session.secretHash],
      );
      return transaction.query<{ id: string }>("SELECT id FROM sessions");
    });
    expect(visibleSession.rows).toEqual([{ id: session.id }]);

    const visibleAudit = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      await transaction.query(
        "INSERT INTO audit_logs (organization_id, action, resource, resource_id, result, request_metadata) VALUES (NULL, 'AUTH_LOGIN_FAILURE', 'authentication', 'unknown', 'FAILURE', '{\"requestId\":\"request-test\"}')",
      );
      return transaction.query("SELECT id FROM audit_logs");
    });
    expect(visibleAudit.rows).toEqual([]);

    await expect(
      client.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "INSERT INTO audit_logs (organization_id, action, resource, resource_id, result, request_metadata) VALUES (NULL, 'unscoped.update', 'organization', 'unknown', 'FAILURE', '{}')",
        );
      }),
    ).rejects.toThrow();

    await expect(
      database.insert(schema.users).values({
        email: email.toUpperCase(),
        displayName: "Duplicate Normalized Email",
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(schema.users).values({
        email: `UPPER-${crypto.randomUUID()}@example.test`,
        displayName: "Non-normalized Email",
      }),
    ).rejects.toThrow();
  });

  it("changes a credential and revokes every session atomically", async () => {
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `password-change-${crypto.randomUUID()}@example.test`,
        displayName: "Password Change User",
        passwordHash: "previous-hash",
      })
      .returning();
    if (!user) throw new Error("Password-change user was not created");
    const [currentSession, otherSession] = await database
      .insert(schema.sessions)
      .values([
        {
          secretHash: createHash("sha256")
            .update(crypto.randomUUID())
            .digest("hex"),
          userId: user.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          secretHash: createHash("sha256")
            .update(crypto.randomUUID())
            .digest("hex"),
          userId: user.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ])
      .returning();
    if (!currentSession || !otherSession) {
      throw new Error("Password-change sessions were not created");
    }

    const identity = createIdentityRepository(database as unknown as Database);
    const event = {
      action: "AUTH_PASSWORD_CHANGED",
      actorUserId: user.id,
      resourceId: currentSession.id,
      result: "SUCCESS" as const,
      requestId: crypto.randomUUID(),
      ipAddress: "127.0.0.1",
      userAgent: "persistence-test",
      occurredAt: new Date(),
    };
    expect(
      await identity.changePasswordAndRevokeSessions(
        user.id,
        currentSession.secretHash,
        "previous-hash",
        "replacement-hash",
        event,
      ),
    ).toBe(true);

    const state = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      await transaction.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [user.id],
      );
      const updatedUser = await transaction.query<{
        password_hash: string;
      }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
      const revokedSessions = await transaction.query<{
        id: string;
        revoked_at: Date | null;
      }>("SELECT id, revoked_at FROM sessions WHERE user_id = $1 ORDER BY id", [
        user.id,
      ]);
      return { updatedUser, revokedSessions };
    });
    expect(state.updatedUser.rows).toEqual([
      { password_hash: "replacement-hash" },
    ]);
    expect(state.revokedSessions.rows).toHaveLength(2);
    expect(
      state.revokedSessions.rows.every((session) => session.revoked_at),
    ).toBe(true);
    expect(
      await identity.changePasswordAndRevokeSessions(
        user.id,
        currentSession.secretHash,
        "replacement-hash",
        "third-hash",
        event,
      ),
    ).toBe(false);
  });

  it("rejects configuration context for inactive memberships and suspended organizations", async () => {
    const activeOrganization = await createOrganization("Active Context Org");
    const suspendedOrganization = await createOrganization(
      "Suspended Context Org",
    );
    const [activeUser] = await database
      .insert(schema.users)
      .values({
        email: `active-context-${crypto.randomUUID()}@example.test`,
        displayName: "Active Context User",
      })
      .returning();
    const [inactiveMembershipUser] = await database
      .insert(schema.users)
      .values({
        email: `inactive-context-${crypto.randomUUID()}@example.test`,
        displayName: "Inactive Context User",
      })
      .returning();
    if (!activeUser || !inactiveMembershipUser) {
      throw new Error("Context test identities were not created");
    }
    await database.insert(schema.organizationMemberships).values([
      {
        organizationId: activeOrganization.id,
        userId: activeUser.id,
        status: "ACTIVE",
      },
      {
        organizationId: activeOrganization.id,
        userId: inactiveMembershipUser.id,
        status: "SUSPENDED",
      },
      {
        organizationId: suspendedOrganization.id,
        userId: activeUser.id,
        status: "ACTIVE",
      },
    ]);
    await database
      .update(schema.organizations)
      .set({ status: "SUSPENDED" })
      .where(eq(schema.organizations.id, suspendedOrganization.id));

    const trustedDatabase = database as unknown as Database;
    const active = await withActiveOrganizationTransaction(
      trustedDatabase,
      activeUser.id,
      activeOrganization.id,
      async (_transaction, membership) => membership.membershipId,
    );
    const inactiveMembership = await withActiveOrganizationTransaction(
      trustedDatabase,
      inactiveMembershipUser.id,
      activeOrganization.id,
      async () => "unexpected",
    );
    const suspendedOrganizationContext =
      await withActiveOrganizationTransaction(
        trustedDatabase,
        activeUser.id,
        suspendedOrganization.id,
        async () => "unexpected",
      );

    expect(active).toBeTruthy();
    expect(inactiveMembership).toBeUndefined();
    expect(suspendedOrganizationContext).toBeUndefined();
  });

  it("keeps module availability, organization entitlement, features, and flags distinct", async () => {
    const organization = await createOrganization("Entitlement Tenant");
    const moduleKey = `core.test.m${crypto.randomUUID().replaceAll("-", "")}`;
    const manifest = moduleManifestSchema.parse({
      name: moduleKey,
      version: "1.0.0",
      displayName: "Test Platform Module",
      dependencies: [],
      permissions: [],
      features: [],
      lifecycle: "AVAILABLE",
    });
    const [module] = await database
      .insert(schema.modules)
      .values({
        key: moduleKey,
        name: manifest.displayName,
        lifecycle: "AVAILABLE",
        isAvailable: true,
      })
      .returning();
    if (!module) throw new Error("Test module was not created");
    await database.insert(schema.moduleVersions).values({
      moduleId: module.id,
      version: manifest.version,
      status: manifest.lifecycle,
      manifest,
    });
    const [feature] = await database
      .insert(schema.features)
      .values({
        moduleId: module.id,
        key: "advanced-setting",
        name: "Advanced Setting",
      })
      .returning();
    const [flag] = await database
      .insert(schema.featureFlags)
      .values({
        key: `FLAG_${crypto.randomUUID().replaceAll("-", "")}`,
        description: "Organization-level test flag.",
      })
      .returning();
    if (!feature || !flag)
      throw new Error("Test feature or flag was not created");

    await asTenant(organization.id, async (transaction) => {
      await transaction.query(
        "INSERT INTO organization_modules (organization_id, module_id, status, source) VALUES ($1, $2, 'ENABLED', 'MANUAL')",
        [organization.id, module.id],
      );
      await transaction.query(
        "INSERT INTO organization_features (organization_id, feature_id, enabled, source) VALUES ($1, $2, false, 'SUBSCRIPTION')",
        [organization.id, feature.id],
      );
      await transaction.query(
        "INSERT INTO feature_flag_assignments (flag_id, scope, organization_id, enabled) VALUES ($1, 'ORGANIZATION', $2, true)",
        [flag.id, organization.id],
      );
    });

    const entitlement = await asTenant(organization.id, (transaction) =>
      transaction.query<{ status: string }>(
        "SELECT status FROM organization_modules WHERE organization_id = $1",
        [organization.id],
      ),
    );
    const featureState = await asTenant(organization.id, (transaction) =>
      transaction.query<{ enabled: boolean }>(
        "SELECT enabled FROM organization_features WHERE organization_id = $1",
        [organization.id],
      ),
    );
    const flagAssignment = await asTenant(organization.id, (transaction) =>
      transaction.query<{ enabled: boolean }>(
        "SELECT enabled FROM feature_flag_assignments WHERE organization_id = $1",
        [organization.id],
      ),
    );

    expect(module.isAvailable).toBe(true);
    expect(entitlement.rows[0]?.status).toBe("ENABLED");
    expect(featureState.rows[0]?.enabled).toBe(false);
    expect(flagAssignment.rows[0]?.enabled).toBe(true);
  });

  it("resolves feature flag overrides from narrowest to broadest scope", () => {
    const assignments = [
      {
        scope: "GLOBAL" as const,
        enabled: false,
        environment: null,
        moduleId: null,
        organizationId: null,
        userId: null,
      },
      {
        scope: "ORGANIZATION" as const,
        enabled: true,
        environment: null,
        moduleId: null,
        organizationId: "organization-a",
        userId: null,
      },
      {
        scope: "USER" as const,
        enabled: false,
        environment: null,
        moduleId: null,
        organizationId: "organization-a",
        userId: "user-a",
      },
    ];

    expect(
      evaluateFeatureFlag(false, assignments, {
        organizationId: "organization-a",
        userId: "user-a",
      }),
    ).toBe(false);
    expect(
      evaluateFeatureFlag(false, assignments, {
        organizationId: "organization-a",
        userId: "user-b",
      }),
    ).toBe(true);
    expect(
      evaluateFeatureFlag(false, assignments, {
        organizationId: "organization-b",
      }),
    ).toBe(false);
  });

  it("fails closed without verified tenant context or module entitlement", () => {
    const definition = {
      key: "module.enabled",
      valueType: "BOOLEAN" as const,
      defaultValue: false,
      isSecuritySensitive: false,
    };
    const moduleAssignment = {
      scope: "MODULE" as const,
      enabled: true,
      value: true,
      environment: null,
      moduleId: "module-a",
      organizationId: null,
      branchId: null,
      userId: null,
    };
    const context = {
      authenticated: true,
      organizationId: "organization-a",
      moduleId: "module-a",
      organizationActive: true,
      membershipActive: true,
      moduleEntitlements: new Map([["module-a", false]]),
    };

    expect(resolveFeatureFlag(definition, [moduleAssignment], context)).toBe(
      false,
    );
    expect(
      resolveFeatureFlag(definition, [moduleAssignment], {
        ...context,
        moduleEntitlements: new Map([["module-a", true]]),
      }),
    ).toBe(true);
    expect(
      resolveFeatureFlag(definition, [moduleAssignment], {
        organizationId: context.organizationId,
        authenticated: true,
        organizationActive: context.organizationActive,
        membershipActive: context.membershipActive,
        moduleEntitlements: new Map(),
      }),
    ).toBe(false);
    expect(resolveFeatureFlag(definition, [moduleAssignment], null)).toBe(
      false,
    );
    expect(
      resolveFeatureFlag(definition, [moduleAssignment], {
        ...context,
        membershipActive: false,
      }),
    ).toBe(false);
  });

  it("resolves typed branch overrides and rejects unsafe values", () => {
    const definition = {
      key: "branding.theme",
      valueType: "STRING" as const,
      defaultValue: "default",
      isSecuritySensitive: false,
    };
    const assignments = [
      {
        scope: "ORGANIZATION" as const,
        enabled: false,
        value: "organization-theme",
        environment: null,
        moduleId: null,
        organizationId: "organization-a",
        branchId: null,
        userId: null,
      },
      {
        scope: "BRANCH" as const,
        enabled: false,
        value: "branch-theme",
        environment: null,
        moduleId: null,
        organizationId: "organization-a",
        branchId: "branch-a",
        userId: null,
      },
    ];
    const context = {
      authenticated: true,
      organizationId: "organization-a",
      branchId: "branch-a",
      organizationActive: true,
      membershipActive: true,
      moduleEntitlements: new Map<string, boolean>(),
    };

    expect(resolveFeatureFlag(definition, assignments, context)).toBe(
      "branch-theme",
    );
    expect(parseFeatureFlagValue("NUMBER", 42)).toBe(42);
    expect(() => parseFeatureFlagValue("NUMBER", "42")).toThrow();

    const securityDefinition = {
      key: "tenant.isolation",
      valueType: "BOOLEAN" as const,
      defaultValue: false,
      isSecuritySensitive: true,
    };
    const unsafeAssignment = {
      scope: "ORGANIZATION" as const,
      enabled: false,
      value: true,
      environment: null,
      moduleId: null,
      organizationId: "organization-a",
      branchId: null,
      userId: null,
    };
    expect(
      resolveFeatureFlag(securityDefinition, [unsafeAssignment], context),
    ).toBe(false);
  });

  it("requires branch feature assignments to use a branch from the same organization", async () => {
    const organizationA = await createOrganization("Branch Feature A");
    const organizationB = await createOrganization("Branch Feature B");
    const [branchA] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationA.id,
        name: "Feature Branch A",
        code: "FEATURE-A",
      })
      .returning();
    const [branchB] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationB.id,
        name: "Feature Branch B",
        code: "FEATURE-B",
      })
      .returning();
    const [flag] = await database
      .insert(schema.featureFlags)
      .values({
        key: `BRANCH_FLAG_${crypto.randomUUID().replaceAll("-", "")}`,
        description: "Branch assignment foreign-key test.",
      })
      .returning();
    if (!branchA || !branchB || !flag) {
      throw new Error("Branch assignment fixtures were not created");
    }

    await database.insert(schema.featureFlagAssignments).values({
      flagId: flag.id,
      scope: "ORGANIZATION",
      scopeKey: "BRANCH",
      organizationId: organizationA.id,
      branchId: branchA.id,
      enabled: true,
      value: true,
    });
    await expect(
      database.insert(schema.featureFlagAssignments).values({
        flagId: flag.id,
        scope: "ORGANIZATION",
        scopeKey: "BRANCH",
        organizationId: organizationA.id,
        branchId: branchB.id,
        enabled: true,
        value: true,
      }),
    ).rejects.toThrow();
  });

  it("keeps custom fields tenant-scoped and rejects cross-tenant values", async () => {
    const organizationA = await createOrganization("Custom Field A");
    const organizationB = await createOrganization("Custom Field B");
    const [definitionA] = await database
      .insert(schema.customFieldDefinitions)
      .values({
        organizationId: organizationA.id,
        entityType: "test-record",
        key: "reference-number",
        label: "Reference Number",
        fieldType: "TEXT",
      })
      .returning();
    if (!definitionA) throw new Error("Test custom field was not created");

    await database.insert(schema.customFieldValues).values({
      organizationId: organizationA.id,
      definitionId: definitionA.id,
      resourceType: "test-record",
      resourceId: crypto.randomUUID(),
      value: "A-100",
    });

    const tenantDefinitions = await asTenant(organizationA.id, (transaction) =>
      transaction.query<{ key: string }>(
        "SELECT key FROM custom_field_definitions ORDER BY key",
      ),
    );
    expect(tenantDefinitions.rows.map(({ key }) => key)).toEqual([
      "reference-number",
    ]);
    expect(parseCustomFieldValue("TEXT", "A-100")).toBe("A-100");
    expect(() => parseCustomFieldValue("NUMBER", "not-a-number")).toThrow();

    await expect(
      database.insert(schema.customFieldValues).values({
        organizationId: organizationB.id,
        definitionId: definitionA.id,
        resourceType: "test-record",
        resourceId: crypto.randomUUID(),
        value: "B-100",
      }),
    ).rejects.toThrow();
  });

  it("isolates every configuration resource under forced tenant RLS", async () => {
    const organizationA = await createOrganization("Configuration Tenant A");
    const organizationB = await createOrganization("Configuration Tenant B");
    const flagId = crypto.randomUUID();
    const workflowAId = crypto.randomUUID();
    const workflowBId = crypto.randomUUID();

    await database.insert(schema.organizationSettings).values([
      {
        organizationId: organizationA.id,
        countryCode: "KE",
        currencyCode: "KES",
        timezone: "Africa/Nairobi",
      },
      {
        organizationId: organizationB.id,
        countryCode: "UG",
        currencyCode: "UGX",
        timezone: "Africa/Kampala",
      },
    ]);
    await database.insert(schema.businessSettings).values([
      { organizationId: organizationA.id, legalName: "Tenant A Ltd" },
      { organizationId: organizationB.id, legalName: "Tenant B Ltd" },
    ]);
    await database.insert(schema.organizationBranding).values([
      { organizationId: organizationA.id, logoUrl: "storage://a/logo" },
      { organizationId: organizationB.id, logoUrl: "storage://b/logo" },
    ]);
    await database.insert(schema.notificationConfigurations).values([
      { organizationId: organizationA.id, preferences: { events: [] } },
      { organizationId: organizationB.id, preferences: { events: [] } },
    ]);
    await database.insert(schema.customFieldDefinitions).values([
      {
        organizationId: organizationA.id,
        entityType: "test_record",
        key: "tenant_code",
        label: "Tenant A Code",
        fieldType: "TEXT",
      },
      {
        organizationId: organizationB.id,
        entityType: "test_record",
        key: "tenant_code",
        label: "Tenant B Code",
        fieldType: "TEXT",
      },
    ]);
    await database.insert(schema.workflowDefinitions).values([
      {
        id: workflowAId,
        organizationId: organizationA.id,
        key: "tenant_flow",
        name: "Tenant A Flow",
      },
      {
        id: workflowBId,
        organizationId: organizationB.id,
        key: "tenant_flow",
        name: "Tenant B Flow",
      },
    ]);
    const [integrationA, integrationB] = await database
      .insert(schema.integrations)
      .values([
        {
          organizationId: organizationA.id,
          key: "mail",
          provider: "EMAIL_PROVIDER",
          secretReference: "secret/a",
        },
        {
          organizationId: organizationB.id,
          key: "mail",
          provider: "EMAIL_PROVIDER",
          secretReference: "secret/b",
        },
      ])
      .returning();
    if (!integrationA || !integrationB) {
      throw new Error("Tenant integrations were not created");
    }
    const [eventA] = await database
      .insert(schema.outboxEvents)
      .values({
        eventType: "USER_CREATED",
        aggregateType: "user",
        aggregateId: crypto.randomUUID(),
        organizationId: organizationA.id,
        payload: {
          userId: crypto.randomUUID(),
          email: "webhook-a@example.test",
          displayName: "Webhook Tenant A",
        },
        metadata: {},
      })
      .returning();
    const [eventB] = await database
      .insert(schema.outboxEvents)
      .values({
        eventType: "USER_CREATED",
        aggregateType: "user",
        aggregateId: crypto.randomUUID(),
        organizationId: organizationB.id,
        payload: {
          userId: crypto.randomUUID(),
          email: "webhook-b@example.test",
          displayName: "Webhook Tenant B",
        },
        metadata: {},
      })
      .returning();
    if (!eventA || !eventB) throw new Error("Webhook events were not created");
    const [subscriptionA, subscriptionB] = await database
      .insert(schema.webhookSubscriptions)
      .values([
        {
          organizationId: organizationA.id,
          integrationId: integrationA.id,
          endpointUrl: "https://hooks-a.example.test/events",
          eventTypes: ["USER_CREATED"],
          status: "ACTIVE",
          signingSecretReference: "test-reference-a",
        },
        {
          organizationId: organizationB.id,
          integrationId: integrationB.id,
          endpointUrl: "https://hooks-b.example.test/events",
          eventTypes: ["USER_CREATED"],
          status: "ACTIVE",
          signingSecretReference: "test-reference-b",
        },
      ])
      .returning();
    if (!subscriptionA || !subscriptionB) {
      throw new Error("Webhook subscriptions were not created");
    }
    const [deliveryA, deliveryB] = await database
      .insert(schema.webhookDeliveries)
      .values([
        {
          organizationId: organizationA.id,
          subscriptionId: subscriptionA.id,
          eventId: eventA.id,
          eventType: "USER_CREATED",
        },
        {
          organizationId: organizationB.id,
          subscriptionId: subscriptionB.id,
          eventId: eventB.id,
          eventType: "USER_CREATED",
        },
      ])
      .returning();
    if (!deliveryA || !deliveryB) {
      throw new Error("Webhook deliveries were not created");
    }
    await database.insert(schema.webhookDeliveryAttempts).values([
      {
        organizationId: organizationA.id,
        deliveryId: deliveryA.id,
        attemptNumber: 1,
        status: "RETRYING",
        failureCode: "HTTP_503",
      },
      {
        organizationId: organizationB.id,
        deliveryId: deliveryB.id,
        attemptNumber: 1,
        status: "RETRYING",
        failureCode: "HTTP_503",
      },
    ]);
    const globallyUniqueDomain = `shared-${crypto.randomUUID()}.example.test`;
    await database.insert(schema.customDomains).values([
      {
        organizationId: organizationA.id,
        domain: globallyUniqueDomain,
        domainType: "DOMAIN",
      },
      {
        organizationId: organizationB.id,
        domain: `b-${crypto.randomUUID()}.example.test`,
        domainType: "DOMAIN",
      },
    ]);
    await expect(
      database.insert(schema.customDomains).values({
        organizationId: organizationB.id,
        domain: globallyUniqueDomain,
        domainType: "DOMAIN",
      }),
    ).rejects.toThrow();
    await database.insert(schema.featureFlags).values({
      id: flagId,
      key: `tenant-flag-${crypto.randomUUID()}`,
      description: "Tenant isolation test flag.",
    });
    await database.insert(schema.featureFlagAssignments).values([
      {
        flagId,
        scope: "ORGANIZATION",
        scopeKey: "ORGANIZATION",
        organizationId: organizationA.id,
        enabled: true,
        value: true,
      },
      {
        flagId,
        scope: "ORGANIZATION",
        scopeKey: "ORGANIZATION",
        organizationId: organizationB.id,
        enabled: true,
        value: true,
      },
    ]);

    const visible = await asTenant(organizationA.id, async (transaction) => ({
      settings: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM organization_settings",
      ),
      business: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM business_settings",
      ),
      branding: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM organization_branding",
      ),
      notifications: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM notification_configurations",
      ),
      fields: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM custom_field_definitions",
      ),
      workflows: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM workflow_definitions",
      ),
      integrations: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM integrations",
      ),
      webhooks: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM webhook_subscriptions",
      ),
      webhookDeliveries: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM webhook_deliveries",
      ),
      webhookAttempts: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM webhook_delivery_attempts",
      ),
      domains: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM custom_domains",
      ),
      assignments: await transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM feature_flag_assignments",
      ),
      updateSettings: await transaction.query(
        "UPDATE organization_settings SET timezone = 'Etc/UTC' WHERE organization_id = $1 RETURNING organization_id",
        [organizationB.id],
      ),
      deleteField: await transaction.query(
        "DELETE FROM custom_field_definitions WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      updateWorkflow: await transaction.query(
        "UPDATE workflow_definitions SET name = 'tampered' WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      updateNotification: await transaction.query(
        "UPDATE notification_configurations SET preferences = '{}' WHERE organization_id = $1 RETURNING organization_id",
        [organizationB.id],
      ),
      updateIntegration: await transaction.query(
        "UPDATE integrations SET configuration = '{\"tampered\":true}' WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      updateWebhook: await transaction.query(
        "UPDATE webhook_subscriptions SET status = 'DISABLED' WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      deleteWebhookDelivery: await transaction.query(
        "DELETE FROM webhook_deliveries WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      updateWebhookAttempt: await transaction.query(
        "UPDATE webhook_delivery_attempts SET failure_code = 'tampered' WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      updateDomain: await transaction.query(
        "UPDATE custom_domains SET is_primary = true WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
      updateAssignment: await transaction.query(
        "UPDATE feature_flag_assignments SET enabled = false WHERE organization_id = $1 RETURNING id",
        [organizationB.id],
      ),
    }));

    for (const rows of [
      visible.settings.rows,
      visible.business.rows,
      visible.branding.rows,
      visible.notifications.rows,
      visible.fields.rows,
      visible.workflows.rows,
      visible.integrations.rows,
      visible.webhooks.rows,
      visible.webhookDeliveries.rows,
      visible.webhookAttempts.rows,
      visible.domains.rows,
      visible.assignments.rows,
    ]) {
      expect(rows).toEqual([{ organization_id: organizationA.id }]);
    }
    for (const rows of [
      visible.updateSettings.rows,
      visible.deleteField.rows,
      visible.updateWorkflow.rows,
      visible.updateNotification.rows,
      visible.updateIntegration.rows,
      visible.updateWebhook.rows,
      visible.deleteWebhookDelivery.rows,
      visible.updateWebhookAttempt.rows,
      visible.updateDomain.rows,
      visible.updateAssignment.rows,
    ]) {
      expect(rows).toEqual([]);
    }

    const missingContext = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      const settings = await transaction.query(
        "SELECT organization_id FROM organization_settings",
      );
      const integrations = await transaction.query(
        "SELECT organization_id FROM integrations",
      );
      const webhooks = await transaction.query(
        "SELECT organization_id FROM webhook_subscriptions",
      );
      const webhookDeliveries = await transaction.query(
        "SELECT organization_id FROM webhook_deliveries",
      );
      const webhookAttempts = await transaction.query(
        "SELECT organization_id FROM webhook_delivery_attempts",
      );
      const deleted = await transaction.query(
        "DELETE FROM custom_domains RETURNING id",
      );
      return {
        settings,
        integrations,
        webhooks,
        webhookDeliveries,
        webhookAttempts,
        deleted,
      };
    });
    expect(missingContext.settings.rows).toEqual([]);
    expect(missingContext.integrations.rows).toEqual([]);
    expect(missingContext.webhooks.rows).toEqual([]);
    expect(missingContext.webhookDeliveries.rows).toEqual([]);
    expect(missingContext.webhookAttempts.rows).toEqual([]);
    expect(missingContext.deleted.rows).toEqual([]);

    const [platformSuperadmin] = await database
      .insert(schema.users)
      .values({
        email: `platform-superadmin-${crypto.randomUUID()}@example.test`,
        displayName: "Platform Superadmin",
        status: "ACTIVE",
      })
      .returning();
    if (!platformSuperadmin)
      throw new Error("Platform Superadmin was not created");
    await database.insert(schema.platformUserRoles).values({
      userId: platformSuperadmin.id,
      role: "SUPERADMIN",
    });
    const superadminTenantView = await client.transaction(
      async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [platformSuperadmin.id],
        );
        await transaction.query(
          "SELECT set_config('app.current_organization_id', $1, true)",
          [organizationA.id],
        );
        const role = await transaction.query<{ role: string }>(
          "SELECT role FROM platform_user_roles",
        );
        const foreignSettings = await transaction.query(
          "SELECT organization_id FROM organization_settings WHERE organization_id = $1",
          [organizationB.id],
        );
        return { role, foreignSettings };
      },
    );
    expect(superadminTenantView.role.rows).toEqual([{ role: "SUPERADMIN" }]);
    expect(superadminTenantView.foreignSettings.rows).toEqual([]);

    const rlsCatalog = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_class
       WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`,
      [
        [
          "organization_settings",
          "business_settings",
          "organization_branding",
          "notification_configurations",
          "custom_field_definitions",
          "custom_field_values",
          "workflow_definitions",
          "workflow_versions",
          "workflow_steps",
          "workflow_transitions",
          "workflow_triggers",
          "workflow_actions",
          "workflow_conditions",
          "workflow_execution_actions",
          "integrations",
          "custom_domains",
          "feature_flag_assignments",
        ],
      ],
    );
    expect(rlsCatalog.rows[0]?.count).toBe(17);
  });

  it("enforces version activation, append-only audit records, and database constraints", async () => {
    const organization = await createOrganization("Workflow Tenant");
    const [workflow] = await database
      .insert(schema.workflowDefinitions)
      .values({
        organizationId: organization.id,
        key: "approval",
        name: "Approval",
      })
      .returning();
    if (!workflow) throw new Error("Test workflow was not created");

    const [firstVersion] = await database
      .insert(schema.workflowVersions)
      .values({
        organizationId: organization.id,
        workflowId: workflow.id,
        version: 1,
        status: "PUBLISHED",
      })
      .returning();
    if (!firstVersion) throw new Error("Test workflow version was not created");

    await expect(
      database.insert(schema.workflowVersions).values({
        organizationId: organization.id,
        workflowId: workflow.id,
        version: 2,
        status: "PUBLISHED",
      }),
    ).rejects.toThrow();

    const [audit] = await database
      .insert(schema.auditLogs)
      .values({
        organizationId: organization.id,
        action: "organization.updated",
        resource: "organization",
        resourceId: organization.id,
        result: "SUCCESS",
      })
      .returning();
    if (!audit) throw new Error("Test audit record was not created");

    await expect(
      database
        .update(schema.auditLogs)
        .set({ action: "tampered" })
        .where(eq(schema.auditLogs.id, audit.id)),
    ).rejects.toThrow();

    await expect(
      database.insert(schema.branches).values({
        organizationId: crypto.randomUUID(),
        name: "Invalid",
        code: "INVALID",
      }),
    ).rejects.toThrow();
  });

  it("commits and rolls back state, mutation audit, and canonical outbox together", async () => {
    const committedOrganization = await createOrganization(
      "Committed Outbox Tenant",
    );
    const rolledBackOrganization = await createOrganization(
      "Rolled Back Outbox Tenant",
    );
    const committedEvent = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: committedOrganization.id,
      aggregateType: "organization_configuration",
      aggregateId: committedOrganization.id,
      payload: {
        resource: "organization_configuration",
        resourceId: committedOrganization.id,
        changedFields: ["transaction-test"],
      },
      metadata: { requestId: "outbox-commit-test" },
    });
    const rolledBackEvent = createDomainEvent({
      ...committedEvent,
      eventId: crypto.randomUUID(),
      organizationId: rolledBackOrganization.id,
      aggregateId: rolledBackOrganization.id,
      payload: {
        ...committedEvent.payload,
        resourceId: rolledBackOrganization.id,
      },
    });

    await database.transaction(async (transaction) => {
      await transaction.insert(schema.organizationConfigurations).values({
        organizationId: committedOrganization.id,
        key: "transaction-test",
        value: { committed: true },
      });
      await transaction.insert(schema.auditLogs).values({
        organizationId: committedOrganization.id,
        action: "organization_configuration.updated",
        resource: "organization_configuration",
        resourceId: committedOrganization.id,
        result: "SUCCESS",
      });
      await recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        committedEvent,
      );
    });

    await expect(
      database.transaction(async (transaction) => {
        await transaction.insert(schema.organizationConfigurations).values({
          organizationId: rolledBackOrganization.id,
          key: "transaction-test",
          value: { committed: false },
        });
        await transaction.insert(schema.auditLogs).values({
          organizationId: rolledBackOrganization.id,
          action: "organization_configuration.updated",
          resource: "organization_configuration",
          resourceId: rolledBackOrganization.id,
          result: "SUCCESS",
        });
        await recordOutboxEvent(
          transaction as unknown as OrganizationTransaction,
          rolledBackEvent,
        );
        throw new Error("Force transaction rollback");
      }),
    ).rejects.toThrow("Force transaction rollback");

    const committedConfiguration = await database
      .select()
      .from(schema.organizationConfigurations)
      .where(
        eq(
          schema.organizationConfigurations.organizationId,
          committedOrganization.id,
        ),
      );
    const committedOutbox = await database
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, committedEvent.eventId));
    const committedAudits = await database
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, committedOrganization.id));
    expect(committedConfiguration).toHaveLength(1);
    expect(committedOutbox).toHaveLength(1);
    expect(committedOutbox[0]?.eventType).toBe("CONFIGURATION_CHANGED");
    expect(committedAudits.map(({ action }) => action).sort()).toEqual([
      "EVENT_CREATED",
      "organization_configuration.updated",
    ]);

    const rolledBackConfiguration = await database
      .select()
      .from(schema.organizationConfigurations)
      .where(
        eq(
          schema.organizationConfigurations.organizationId,
          rolledBackOrganization.id,
        ),
      );
    const rolledBackOutbox = await database
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, rolledBackEvent.eventId));
    const rolledBackAudits = await database
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, rolledBackOrganization.id));
    expect(rolledBackConfiguration).toEqual([]);
    expect(rolledBackOutbox).toEqual([]);
    expect(rolledBackAudits).toEqual([]);
  });

  it("executes a handler once for duplicate delivery under tenant context", async () => {
    const organization = await createOrganization("Event Idempotency Tenant");
    const [worker] = await database
      .insert(schema.users)
      .values({
        email: `event-worker-${crypto.randomUUID()}@example.test`,
        displayName: "Event Worker",
      })
      .returning({ id: schema.users.id });
    if (!worker) throw new Error("Event worker was not created");
    const context = eventWorkerContext(organization.id, worker.id);
    const event = createDomainEvent({
      eventType: "FEATURE_FLAG_CHANGED",
      organizationId: organization.id,
      aggregateType: "feature_flag",
      aggregateId: organization.id,
      payload: {
        flagKey: "REPORTING",
        valueType: "BOOLEAN",
        scope: "ORGANIZATION",
      },
    });
    await database.transaction((transaction) =>
      recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        event,
      ),
    );

    const handler: EventHandler = {
      handlerName: "test.idempotent-effect",
      eventType: "FEATURE_FLAG_CHANGED",
      eventVersion: 1,
      owningModule: "core.test",
      requiredModuleEntitlement: null,
      requiredPermissionKey: null,
      handle: async (transaction, deliveredEvent) => {
        await transaction
          .insert(schema.organizationConfigurations)
          .values({
            organizationId: deliveredEvent.organizationId,
            key: "event-handler-effect",
            value: { count: 1 },
          })
          .onConflictDoUpdate({
            target: [
              schema.organizationConfigurations.organizationId,
              schema.organizationConfigurations.key,
            ],
            set: {
              value: sql`jsonb_build_object('count', COALESCE((${schema.organizationConfigurations.value}->>'count')::int, 0) + 1)`,
            },
          });
      },
    };
    const dispatchTime = new Date(Date.now() + 60_000);
    const firstDelivery = await dispatchAsTenant(
      organization.id,
      context,
      [handler],
      { now: dispatchTime },
    );
    expect(firstDelivery).toMatchObject({ claimed: 1, published: 1 });

    await database
      .update(schema.outboxEvents)
      .set({
        status: "PENDING",
        deliveryStatus: "PENDING",
        nextAttemptAt: dispatchTime,
      })
      .where(eq(schema.outboxEvents.id, event.eventId));
    const duplicateDelivery = await dispatchAsTenant(
      organization.id,
      context,
      [handler],
      { now: dispatchTime },
    );
    const [effect] = await database
      .select()
      .from(schema.organizationConfigurations)
      .where(
        eq(schema.organizationConfigurations.organizationId, organization.id),
      );
    expect(duplicateDelivery.skipped).toBe(2);
    expect(effect?.value).toEqual({ count: 1 });
  });

  it("queues only selected webhook events and keeps delivery IDs stable", async () => {
    const organization = await createOrganization("Webhook Outbox Tenant");
    const [worker] = await database
      .insert(schema.users)
      .values({
        email: `webhook-worker-${crypto.randomUUID()}@example.test`,
        displayName: "Webhook Worker",
      })
      .returning({ id: schema.users.id });
    const [integration] = await database
      .insert(schema.integrations)
      .values({
        organizationId: organization.id,
        key: "outbound-webhooks",
        provider: "WEBHOOK",
      })
      .returning();
    if (!worker || !integration) {
      throw new Error("Webhook dispatch fixtures were not created");
    }
    await database.insert(schema.webhookSubscriptions).values({
      organizationId: organization.id,
      integrationId: integration.id,
      endpointUrl: "https://hooks.example.test/events",
      eventTypes: ["USER_CREATED"],
      status: "ACTIVE",
      signingSecretReference: "test-webhook-secret-reference",
    });
    const selectedEvent = createDomainEvent({
      eventType: "USER_CREATED",
      organizationId: organization.id,
      aggregateType: "user",
      aggregateId: crypto.randomUUID(),
      payload: {
        userId: crypto.randomUUID(),
        email: "selected-event@example.test",
        displayName: "Selected Event",
      },
    });
    const filteredEvent = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: organization.id,
      aggregateType: "organization_configuration",
      aggregateId: organization.id,
      payload: {
        resource: "organization_configuration",
        resourceId: organization.id,
        changedFields: ["timezone"],
      },
    });
    await database.transaction(async (transaction) => {
      await recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        selectedEvent,
      );
      await recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        filteredEvent,
      );
    });

    const context = eventWorkerContext(organization.id, worker.id);
    const dispatchTime = new Date(Date.now() + 60_000);
    const dispatched = await dispatchAsTenant(
      organization.id,
      context,
      platformWebhookEventHandlers,
      { now: dispatchTime },
    );
    expect(dispatched).toMatchObject({ claimed: 2, published: 2 });
    const queued = await database
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.organizationId, organization.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      eventId: selectedEvent.eventId,
      eventType: "USER_CREATED",
      status: "PENDING",
    });
    const deliveryId = queued[0]!.id;

    await database
      .update(schema.outboxEvents)
      .set({
        status: "PENDING",
        deliveryStatus: "PENDING",
        nextAttemptAt: dispatchTime,
      })
      .where(eq(schema.outboxEvents.id, selectedEvent.eventId));
    await dispatchAsTenant(
      organization.id,
      context,
      platformWebhookEventHandlers,
      { now: dispatchTime },
    );
    const afterDuplicate = await database
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.organizationId, organization.id));
    expect(afterDuplicate).toHaveLength(1);
    expect(afterDuplicate[0]?.id).toBe(deliveryId);
  });

  it("fails closed for missing or forged dispatch tenant and branch context", async () => {
    const organizationA = await createOrganization("Event Context Tenant A");
    const organizationB = await createOrganization("Event Context Tenant B");
    const [workerA] = await database
      .insert(schema.users)
      .values({
        email: `event-context-a-${crypto.randomUUID()}@example.test`,
        displayName: "Event Context Worker A",
      })
      .returning({ id: schema.users.id });
    const [workerB] = await database
      .insert(schema.users)
      .values({
        email: `event-context-b-${crypto.randomUUID()}@example.test`,
        displayName: "Event Context Worker B",
      })
      .returning({ id: schema.users.id });
    if (!workerA || !workerB) throw new Error("Event context worker missing");

    const event = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: organizationA.id,
      aggregateType: "organization_configuration",
      aggregateId: organizationA.id,
      payload: {
        resource: "organization_configuration",
        resourceId: organizationA.id,
        changedFields: ["timezone"],
      },
    });
    await database.transaction((transaction) =>
      recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        event,
      ),
    );

    let executions = 0;
    const handler: EventHandler = {
      handlerName: "test.tenant-context",
      eventType: "CONFIGURATION_CHANGED",
      eventVersion: 1,
      owningModule: "core.test",
      requiredModuleEntitlement: null,
      requiredPermissionKey: null,
      handle: async () => {
        executions += 1;
      },
    };
    const contextA = eventWorkerContext(organizationA.id, workerA.id);
    const contextB = eventWorkerContext(organizationB.id, workerB.id);
    const forgedOrganizationContext = {
      ...contextB,
      platformRoles: [...contextB.platformRoles, "SUPERADMIN" as const],
    };
    const forgedBranchContext = {
      ...contextA,
      branchId: crypto.randomUUID(),
    };

    await expect(
      dispatchAsTenant(organizationA.id, forgedOrganizationContext, [handler]),
    ).rejects.toMatchObject({
      kind: "AUTHORIZATION_FAILURE",
      reasonCode: "TENANT_CONTEXT_MISSING_OR_INVALID",
    });
    await expect(
      dispatchAsTenant(organizationA.id, forgedBranchContext, [handler]),
    ).rejects.toMatchObject({
      kind: "AUTHORIZATION_FAILURE",
      reasonCode: "TENANT_CONTEXT_MISSING_OR_INVALID",
    });
    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
        return dispatchOutboxBatch(
          transaction as unknown as OrganizationTransaction,
          contextA,
          [handler],
        );
      }),
    ).rejects.toMatchObject({
      kind: "AUTHORIZATION_FAILURE",
      reasonCode: "TENANT_CONTEXT_MISSING_OR_INVALID",
    });
    expect(executions).toBe(0);
  });

  it("does not dispatch branch events to another authorized branch", async () => {
    const organization = await createOrganization("Branch Event Tenant");
    const [branchA, branchB] = await database
      .insert(schema.branches)
      .values([
        {
          organizationId: organization.id,
          name: "Branch Event A",
          code: `EVENT-A-${crypto.randomUUID()}`,
        },
        {
          organizationId: organization.id,
          name: "Branch Event B",
          code: `EVENT-B-${crypto.randomUUID()}`,
        },
      ])
      .returning();
    const [worker] = await database
      .insert(schema.users)
      .values({
        email: `event-branch-worker-${crypto.randomUUID()}@example.test`,
        displayName: "Branch Event Worker",
      })
      .returning({ id: schema.users.id });
    if (!branchA || !branchB || !worker) {
      throw new Error("Branch event fixture was not created");
    }

    const event = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: organization.id,
      branchId: branchB.id,
      aggregateType: "organization_configuration",
      aggregateId: organization.id,
      payload: {
        resource: "organization_configuration",
        resourceId: organization.id,
        changedFields: ["timezone"],
      },
    });
    await database.transaction((transaction) =>
      recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        event,
      ),
    );

    let executions = 0;
    const handler: EventHandler = {
      handlerName: "test.branch-event",
      eventType: "CONFIGURATION_CHANGED",
      eventVersion: 1,
      owningModule: "core.test",
      requiredModuleEntitlement: null,
      requiredPermissionKey: null,
      handle: async () => {
        executions += 1;
      },
    };
    const baseContext = eventWorkerContext(organization.id, worker.id);
    const contextForBranch = (branch: typeof branchA) => ({
      ...baseContext,
      branchId: branch.id,
      branch: { branchId: branch.id, name: branch.name, code: branch.code },
    });

    const otherBranchResult = await dispatchAsTenant(
      organization.id,
      contextForBranch(branchA),
      [handler],
    );
    expect(otherBranchResult.claimed).toBe(0);
    expect(executions).toBe(0);

    const owningBranchResult = await dispatchAsTenant(
      organization.id,
      contextForBranch(branchB),
      [handler],
    );
    expect(owningBranchResult).toMatchObject({ claimed: 1, published: 1 });
    expect(executions).toBe(1);
  });

  it("does not execute optional handlers without an enabled module entitlement", async () => {
    const organization = await createOrganization(
      "Event Optional Module Tenant",
    );
    const [worker] = await database
      .insert(schema.users)
      .values({
        email: `event-optional-module-worker-${crypto.randomUUID()}@example.test`,
        displayName: "Optional Module Event Worker",
      })
      .returning({ id: schema.users.id });
    if (!worker)
      throw new Error("Optional module event worker was not created");
    const moduleKey = `core.test.m${crypto.randomUUID().replaceAll("-", "")}`;
    const manifest = moduleManifestSchema.parse({
      name: moduleKey,
      version: "1.0.0",
      displayName: "Optional Event Handler Module",
      dependencies: [],
      permissions: [],
      features: [],
      lifecycle: "AVAILABLE",
    });
    const [module] = await database
      .insert(schema.modules)
      .values({
        key: moduleKey,
        name: manifest.displayName,
        lifecycle: "AVAILABLE",
        isAvailable: true,
      })
      .returning();
    if (!module) throw new Error("Optional event module was not created");
    await database.insert(schema.moduleVersions).values({
      moduleId: module.id,
      version: manifest.version,
      status: manifest.lifecycle,
      manifest,
    });

    const event = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: organization.id,
      aggregateType: "organization_configuration",
      aggregateId: organization.id,
      payload: {
        resource: "organization_configuration",
        resourceId: organization.id,
        changedFields: ["timezone"],
      },
    });
    await database.transaction((transaction) =>
      recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        event,
      ),
    );

    let executions = 0;
    const handler: EventHandler = {
      handlerName: "test.optional-module-handler",
      eventType: "CONFIGURATION_CHANGED",
      eventVersion: 1,
      owningModule: moduleKey,
      requiredModuleEntitlement: moduleKey,
      requiredPermissionKey: null,
      handle: async () => {
        executions += 1;
      },
    };
    const result = await dispatchAsTenant(
      organization.id,
      eventWorkerContext(organization.id, worker.id),
      [handler],
      { now: new Date(Date.now() + 60_000) },
    );
    const processingRecords = await database
      .select({
        handlerName: schema.eventProcessingRecords.handlerName,
        status: schema.eventProcessingRecords.status,
        failureKind: schema.eventProcessingRecords.failureKind,
      })
      .from(schema.eventProcessingRecords)
      .where(eq(schema.eventProcessingRecords.eventId, event.eventId));

    expect(result.deadLettered).toBe(1);
    expect(executions).toBe(0);
    expect(processingRecords).toContainEqual(
      expect.objectContaining({
        handlerName: handler.handlerName,
        status: "DEAD_LETTERED",
        failureKind: "MODULE_UNAVAILABLE",
      }),
    );
    expect(processingRecords).toContainEqual(
      expect.objectContaining({
        handlerName: "platform.audit.configuration_changed",
        status: "SUCCEEDED",
      }),
    );
  });

  it("claims concurrent deliveries once using row-lock idempotency", async () => {
    const organization = await createOrganization(
      "Concurrent Event Delivery Tenant",
    );
    const [worker] = await database
      .insert(schema.users)
      .values({
        email: `event-concurrent-worker-${crypto.randomUUID()}@example.test`,
        displayName: "Concurrent Event Worker",
      })
      .returning({ id: schema.users.id });
    if (!worker) throw new Error("Concurrent event worker was not created");
    const event = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: organization.id,
      aggregateType: "organization_configuration",
      aggregateId: organization.id,
      payload: {
        resource: "organization_configuration",
        resourceId: organization.id,
        changedFields: ["timezone"],
      },
    });
    await database.transaction((transaction) =>
      recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        event,
      ),
    );

    let executions = 0;
    const handler: EventHandler = {
      handlerName: "test.concurrent-delivery",
      eventType: "CONFIGURATION_CHANGED",
      eventVersion: 1,
      owningModule: "core.test",
      requiredModuleEntitlement: null,
      requiredPermissionKey: null,
      handle: async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    };
    const context = eventWorkerContext(organization.id, worker.id);
    const outcomes = await Promise.all([
      dispatchAsTenant(organization.id, context, [handler]),
      dispatchAsTenant(organization.id, context, [handler]),
    ]);

    expect(
      outcomes.reduce((claimed, outcome) => claimed + outcome.claimed, 0),
    ).toBe(1);
    expect(
      outcomes.reduce((published, outcome) => published + outcome.published, 0),
    ).toBe(1);
    expect(executions).toBe(1);
  });

  it("retries transient handler failures with backoff and dead-letters at the limit", async () => {
    const organization = await createOrganization("Event Retry Tenant");
    const [worker] = await database
      .insert(schema.users)
      .values({
        email: `event-retry-worker-${crypto.randomUUID()}@example.test`,
        displayName: "Event Retry Worker",
      })
      .returning({ id: schema.users.id });
    if (!worker) throw new Error("Event retry worker was not created");
    const context = eventWorkerContext(organization.id, worker.id);
    const event = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: organization.id,
      aggregateType: "organization_configuration",
      aggregateId: organization.id,
      payload: {
        resource: "organization_configuration",
        resourceId: organization.id,
        changedFields: ["timezone"],
      },
    });
    await database.transaction((transaction) =>
      recordOutboxEvent(
        transaction as unknown as OrganizationTransaction,
        event,
      ),
    );
    const handler: EventHandler = {
      handlerName: "test.transient-failure",
      eventType: "CONFIGURATION_CHANGED",
      eventVersion: 1,
      owningModule: "core.test",
      requiredModuleEntitlement: null,
      requiredPermissionKey: null,
      handle: async () => {
        throw new EventDispatchError(
          "TRANSIENT_INFRASTRUCTURE",
          "TEST_TRANSIENT_FAILURE",
        );
      },
    };
    const firstAttemptAt = new Date(Date.now() + 60_000);
    const firstResult = await dispatchAsTenant(
      organization.id,
      context,
      [handler],
      { now: firstAttemptAt, maxAttempts: 2, baseDelayMs: 1_000 },
    );
    const [retryRecord] = await database
      .select()
      .from(schema.eventProcessingRecords)
      .where(
        and(
          eq(schema.eventProcessingRecords.eventId, event.eventId),
          eq(schema.eventProcessingRecords.handlerName, handler.handlerName),
        ),
      );
    expect(firstResult.failed).toBe(1);
    expect(retryRecord).toMatchObject({
      handlerName: handler.handlerName,
      status: "FAILED",
      attempts: 1,
      failureKind: "TRANSIENT_INFRASTRUCTURE",
      lastError: "TEST_TRANSIENT_FAILURE",
      nextAttemptAt: new Date(firstAttemptAt.getTime() + 1_000),
    });

    const secondResult = await dispatchAsTenant(
      organization.id,
      context,
      [handler],
      {
        now: new Date(firstAttemptAt.getTime() + 2_000),
        maxAttempts: 2,
        baseDelayMs: 1_000,
      },
    );
    const [deadLetter] = await database
      .select()
      .from(schema.eventDeadLetters)
      .where(eq(schema.eventDeadLetters.eventId, event.eventId));
    expect(secondResult.deadLettered).toBe(1);
    expect(deadLetter).toMatchObject({
      handlerName: handler.handlerName,
      failureKind: "TRANSIENT_INFRASTRUCTURE",
      failureReason: "TEST_TRANSIENT_FAILURE",
      attempts: 2,
    });
  });

  it("isolates outbox, processing, and dead-letter rows by tenant", async () => {
    const organizationA = await createOrganization("Event Tenant A");
    const organizationB = await createOrganization("Event Tenant B");
    const [foreignBranch] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationB.id,
        name: "Foreign Event Branch",
        code: `EVENT-${crypto.randomUUID()}`,
      })
      .returning();
    if (!foreignBranch) throw new Error("Foreign branch was not created");

    const [eventA] = await database
      .insert(schema.outboxEvents)
      .values({
        eventType: "CONFIGURATION_CHANGED",
        aggregateType: "organization_configuration",
        aggregateId: organizationA.id,
        organizationId: organizationA.id,
        payload: { resource: "organization_configuration" },
      })
      .returning({ id: schema.outboxEvents.id });
    const [eventB] = await database
      .insert(schema.outboxEvents)
      .values({
        eventType: "CONFIGURATION_CHANGED",
        aggregateType: "organization_configuration",
        aggregateId: organizationB.id,
        organizationId: organizationB.id,
        payload: { resource: "organization_configuration" },
      })
      .returning({ id: schema.outboxEvents.id });
    if (!eventA || !eventB) throw new Error("Test events were not created");

    await database.insert(schema.eventProcessingRecords).values([
      {
        organizationId: organizationA.id,
        eventId: eventA.id,
        eventType: "CONFIGURATION_CHANGED",
        handlerName: "test.tenant-a",
        eventVersion: 1,
      },
      {
        organizationId: organizationB.id,
        eventId: eventB.id,
        eventType: "CONFIGURATION_CHANGED",
        handlerName: "test.tenant-b",
        eventVersion: 1,
      },
    ]);
    await database.insert(schema.eventDeadLetters).values([
      {
        organizationId: organizationA.id,
        eventId: eventA.id,
        eventType: "CONFIGURATION_CHANGED",
        handlerName: "test.tenant-a",
        failureKind: "INVALID_EVENT",
        failureReason: "TEST_FAILURE",
        attempts: 1,
        deadLetteredAt: new Date(),
      },
      {
        organizationId: organizationB.id,
        eventId: eventB.id,
        eventType: "CONFIGURATION_CHANGED",
        handlerName: "test.tenant-b",
        failureKind: "INVALID_EVENT",
        failureReason: "TEST_FAILURE",
        attempts: 1,
        deadLetteredAt: new Date(),
      },
    ]);

    const tenantAEventRows = await asTenant(
      organizationA.id,
      async (transaction) => ({
        outbox: await transaction.query<{ id: string }>(
          "SELECT id FROM outbox_events ORDER BY id",
        ),
        processing: await transaction.query<{ event_id: string }>(
          "SELECT event_id FROM event_processing_records ORDER BY event_id",
        ),
        deadLetters: await transaction.query<{ event_id: string }>(
          "SELECT event_id FROM event_dead_letters ORDER BY event_id",
        ),
      }),
    );
    expect(tenantAEventRows.outbox.rows.map(({ id }) => id)).toEqual([
      eventA.id,
    ]);
    expect(
      tenantAEventRows.processing.rows.map(({ event_id }) => event_id),
    ).toEqual([eventA.id]);
    expect(
      tenantAEventRows.deadLetters.rows.map(({ event_id }) => event_id),
    ).toEqual([eventA.id]);

    await expect(
      asTenant(organizationA.id, (transaction) =>
        transaction.query(
          "INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, organization_id, payload, metadata, version) VALUES ('CONFIGURATION_CHANGED', 'organization_configuration', $1, $2, '{}'::jsonb, '{}'::jsonb, 1)",
          [organizationB.id, organizationB.id],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      database.insert(schema.outboxEvents).values({
        eventType: "CONFIGURATION_CHANGED",
        aggregateType: "organization_configuration",
        aggregateId: organizationA.id,
        organizationId: organizationA.id,
        branchId: foreignBranch.id,
        payload: { resource: "organization_configuration" },
      }),
    ).rejects.toThrow();

    const missingTenantContext = await client.transaction(
      async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        return transaction.query(
          "SELECT id FROM outbox_events UNION ALL SELECT id FROM event_processing_records UNION ALL SELECT id FROM event_dead_letters",
        );
      },
    );
    expect(missingTenantContext.rows).toEqual([]);
  });

  it("creates user-scoped notifications and tenant-filtered PostgreSQL search", async () => {
    const organization = await createOrganization("Platform Inbox and Search");
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `inbox-search-${crypto.randomUUID()}@example.test`,
        displayName: "Inbox Search User",
      })
      .returning();
    if (!user) throw new Error("Inbox/search user was not created");
    const [membership] = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organization.id,
        userId: user.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      })
      .returning();
    if (!membership) throw new Error("Inbox/search membership was not created");

    const context = testAuthorizationContext(
      user.id,
      organization.id,
      membership.id,
    );
    const metadata = { requestId: crypto.randomUUID() };
    const services = createPlatformServices(platformTestAuthorization());
    const notification = await services.createNotification(context, metadata, {
      recipientUserId: user.id,
      notificationType: "platform.notice",
      title: "Platform notice",
      body: "A durable in-app notification.",
    });
    expect(notification.allowed).toBe(true);
    if (!notification.allowed || !notification.value) {
      throw new Error("Notification creation was denied");
    }
    const inbox = await services.listNotifications(context, metadata);
    expect(inbox.allowed).toBe(true);
    if (!inbox.allowed) throw new Error("Inbox read was denied");
    expect(inbox.value).toHaveLength(1);
    expect(inbox.value[0]?.id).toBe(notification.value.id);
    expect(
      await services.setNotificationReadState(
        context,
        metadata,
        notification.value.id,
        true,
      ),
    ).toMatchObject({ allowed: true, value: true });

    const indexing = await services.indexSearchDocument(context, metadata, {
      indexName: "platform_documents",
      documentId: "guide-1",
      title: "Tenant onboarding guide",
      body: "Operators can find the onboarding guide in platform search.",
    });
    expect(indexing).toMatchObject({ allowed: true, value: true });
    const search = await services.search(context, metadata, {
      indexName: "platform_documents",
      query: "onboarding guide",
      limit: 10,
    });
    expect(search.allowed).toBe(true);
    if (!search.allowed) throw new Error("Platform search was denied");
    expect(search.value.map(({ documentId }) => documentId)).toEqual([
      "guide-1",
    ]);

    const eventRows = await asTenant(organization.id, (transaction) =>
      transaction.query<{ event_type: string }>(
        "SELECT event_type FROM outbox_events WHERE event_type IN ('NOTIFICATION_CREATED', 'SEARCH_DOCUMENT_INDEXED') ORDER BY event_type",
      ),
    );
    expect(eventRows.rows.map(({ event_type }) => event_type)).toEqual([
      "NOTIFICATION_CREATED",
      "SEARCH_DOCUMENT_INDEXED",
    ]);
  });

  it("enqueues idempotent jobs and executes a retry under tenant-scoped worker context", async () => {
    const organizationA = await createOrganization("Job Service Tenant A");
    const organizationB = await createOrganization("Job Service Tenant B");
    const [user] = await database
      .insert(schema.users)
      .values({
        email: `job-service-${crypto.randomUUID()}@example.test`,
        displayName: "Job Service User",
      })
      .returning();
    if (!user) throw new Error("Job service user was not created");
    const [membership] = await database
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organizationA.id,
        userId: user.id,
        status: "ACTIVE",
      })
      .returning();
    if (!membership) throw new Error("Job service membership was not created");

    let executions = 0;
    const handler: JobHandler<{ taskId: string }> = {
      jobType: "tests.retry",
      owningModule: "core.jobs",
      requiredModuleEntitlement: null,
      payloadSchema: z.object({ taskId: z.uuid() }).strict(),
      execute: async (transaction, _payload, jobContext) => {
        executions += 1;
        if (executions === 1) {
          throw new JobExecutionError("TEMPORARY_FAILURE", true);
        }
        await transaction.insert(schema.auditLogs).values({
          organizationId: jobContext.organizationId,
          actorUserId: null,
          action: "TEST_JOB_EFFECT",
          resource: "job",
          resourceId: jobContext.jobId,
          result: "SUCCESS",
          requestMetadata: { correlationId: jobContext.correlationId },
        });
      },
    };
    const runtimeDatabase = {
      transaction: <T>(
        operation: (transaction: OrganizationTransaction) => Promise<T>,
      ) =>
        database.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
          return operation(transaction as unknown as OrganizationTransaction);
        }),
    } as unknown as Database;
    const jobs = createJobService(
      runtimeDatabase,
      platformTestAuthorization(),
      createJobHandlerRegistry([handler]),
    );
    const context = testAuthorizationContext(
      user.id,
      organizationA.id,
      membership.id,
    );
    const input = {
      jobType: "tests.retry",
      payload: { taskId: crypto.randomUUID() },
      idempotencyKey: "retry-once",
      maxAttempts: 2,
    };
    const firstEnqueue = await jobs.enqueue(
      context,
      { requestId: crypto.randomUUID() },
      input,
    );
    expect(firstEnqueue.allowed).toBe(true);
    if (!firstEnqueue.allowed || !firstEnqueue.value) {
      throw new Error("Job enqueue was denied");
    }
    expect(
      await jobs.enqueue(context, { requestId: crypto.randomUUID() }, input),
    ).toMatchObject({ allowed: true, value: { id: firstEnqueue.value.id } });

    expect(
      await jobs.processTenantBatch(organizationA.id, null, "worker-retry", {
        retryBaseMilliseconds: 100,
      }),
    ).toMatchObject({ claimed: 1, succeeded: 0, retrying: 1, failed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(
      await jobs.processTenantBatch(organizationA.id, null, "worker-retry"),
    ).toMatchObject({ claimed: 1, succeeded: 1, retrying: 0, failed: 0 });
    expect(executions).toBe(2);
    expect(
      await jobs.processTenantBatch(organizationB.id, null, "worker-other"),
    ).toEqual({ claimed: 0, succeeded: 0, retrying: 0, failed: 0 });

    const result = await database
      .select({
        status: schema.jobs.status,
        attempts: schema.jobs.attempts,
        error: schema.jobs.lastErrorCode,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, firstEnqueue.value.id));
    expect(result).toEqual([
      { status: "SUCCEEDED", attempts: 2, error: "TEMPORARY_FAILURE" },
    ]);
    const attemptOutcomes = await database
      .select({ outcome: schema.jobAttempts.outcome })
      .from(schema.jobAttempts)
      .where(eq(schema.jobAttempts.jobId, firstEnqueue.value.id))
      .orderBy(schema.jobAttempts.attempt);
    expect(attemptOutcomes.map(({ outcome }) => outcome)).toEqual([
      "RETRY_WAIT",
      "SUCCEEDED",
    ]);
  });

  it("fails closed and prevents forged cross-tenant platform object writes", async () => {
    const organizationA = await createOrganization("Storage RLS Tenant A");
    const organizationB = await createOrganization("Storage RLS Tenant B");
    const [branchA] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationA.id,
        name: "Storage branch A",
        code: `STORAGE-A-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning();
    const [branchB] = await database
      .insert(schema.branches)
      .values({
        organizationId: organizationB.id,
        name: "Storage branch B",
        code: `STORAGE-B-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning();
    if (!branchA || !branchB) {
      throw new Error("Storage RLS branches were not created");
    }

    const objectId = crypto.randomUUID();
    await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      await transaction.query(
        "SELECT set_config('app.current_organization_id', $1, true)",
        [organizationA.id],
      );
      await transaction.query(
        "SELECT set_config('app.current_branch_id', $1, true)",
        [branchA.id],
      );
      await transaction.query(
        "INSERT INTO stored_objects (id, organization_id, branch_id, original_filename, storage_key, mime_type, byte_size, checksum_sha256, provider) VALUES ($1, $2, $3, 'report.pdf', $4, 'application/pdf', 20, $5, 'LOCAL')",
        [
          objectId,
          organizationA.id,
          branchA.id,
          crypto.randomUUID(),
          "a".repeat(64),
        ],
      );
    });

    const visibleInOtherTenant = await asTenant(
      organizationB.id,
      (transaction) =>
        transaction.query("SELECT id FROM stored_objects WHERE id = $1", [
          objectId,
        ]),
    );
    expect(visibleInOtherTenant.rows).toEqual([]);
    const visibleWithoutContext = await client.transaction(
      async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        return transaction.query("SELECT id FROM stored_objects");
      },
    );
    expect(visibleWithoutContext.rows).toEqual([]);
    await expect(
      asTenant(organizationA.id, (transaction) =>
        transaction.query(
          "INSERT INTO stored_objects (organization_id, branch_id, original_filename, storage_key, mime_type, byte_size, checksum_sha256, provider) VALUES ($1, $2, 'forged.pdf', $3, 'application/pdf', 20, $4, 'LOCAL')",
          [organizationB.id, branchB.id, crypto.randomUUID(), "b".repeat(64)],
        ),
      ),
    ).rejects.toThrow();

    const visibleFromOtherBranch = await client.transaction(
      async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "SELECT set_config('app.current_organization_id', $1, true)",
          [organizationA.id],
        );
        await transaction.query(
          "SELECT set_config('app.current_branch_id', $1, true)",
          [crypto.randomUUID()],
        );
        return transaction.query("SELECT id FROM stored_objects");
      },
    );
    expect(visibleFromOtherBranch.rows).toEqual([]);
  });
});
