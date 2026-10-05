import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCustomFieldValue } from "@onecore/core-domain";
import { evaluateFeatureFlag } from "../src/feature-flags.js";
import * as schema from "../schema/index.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
let client: PGlite;
let database: PgliteDatabase;

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

describe("PostgreSQL persistence foundation", () => {
  beforeAll(async () => {
    client = new PGlite();
    database = drizzle({ client });
    await migrate(database, { migrationsFolder: migrationsDirectory });

    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onecore_app;
    `);
  });

  afterAll(async () => {
    await client.close();
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
      }>(
        "SELECT rolsuper AS superuser, rolbypassrls AS \"bypassRls\" FROM pg_roles WHERE rolname = 'onecore_app'",
      )
      .then((result) => result.rows);
    expect(applicationRole).toEqual({ superuser: false, bypassRls: false });
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

  it("keeps module availability, organization entitlement, features, and flags distinct", async () => {
    const organization = await createOrganization("Entitlement Tenant");
    const [module] = await database
      .insert(schema.modules)
      .values({
        key: `test-${crypto.randomUUID()}`,
        name: "Test Platform Module",
        isAvailable: true,
      })
      .returning();
    if (!module) throw new Error("Test module was not created");
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

  it("rolls back domain changes and outbox events as one transaction", async () => {
    const organization = await createOrganization(
      "Transactional Outbox Tenant",
    );
    const eventId = crypto.randomUUID();

    await expect(
      database.transaction(async (transaction) => {
        await transaction.insert(schema.organizationConfigurations).values({
          organizationId: organization.id,
          key: "transaction-test",
          value: { committed: false },
        });
        await transaction.insert(schema.outboxEvents).values({
          id: eventId,
          eventType: "ConfigurationChanged",
          aggregateId: organization.id,
          organizationId: organization.id,
          payload: { configurationKey: "transaction-test" },
          version: 1,
        });
        throw new Error("Force transaction rollback");
      }),
    ).rejects.toThrow("Force transaction rollback");

    const [configuration] = await database
      .select()
      .from(schema.organizationConfigurations)
      .where(
        eq(schema.organizationConfigurations.organizationId, organization.id),
      );
    const [event] = await database
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, eventId));
    expect(configuration).toBeUndefined();
    expect(event).toBeUndefined();
  });
});
