import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { getMigrationsToRun } from "drizzle-orm/migrator.utils";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const repairMigrationPath = fileURLToPath(
  new URL(
    "../migrations/20261010040000_branch_permission_backfill_repair/migration.sql",
    import.meta.url,
  ),
);
const branchAdministrationMigrationPath = fileURLToPath(
  new URL(
    "../migrations/20261010020000_branch_administration_contract/migration.sql",
    import.meta.url,
  ),
);
const assignmentMigrationPath = fileURLToPath(
  new URL(
    "../migrations/20261010030000_membership_branch_assignment_contract/migration.sql",
    import.meta.url,
  ),
);

let client: PGlite;
let database: PgliteDatabase;

describe("Branch permission backfill repair", () => {
  beforeAll(async () => {
    client = new PGlite();
    database = drizzle({ client });
    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    `);
    await applyTestMigrations(client, migrationsDirectory);
    await client.exec(`
      ALTER TABLE "role_permissions" OWNER TO onecore_migrator;
      ALTER TABLE "roles" OWNER TO onecore_migrator;
      ALTER TABLE "permissions" OWNER TO onecore_migrator;
      ALTER TABLE "branches" OWNER TO onecore_migrator;
      ALTER TABLE "membership_branches" OWNER TO onecore_migrator;
    `);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("shows an unrecorded historical migration blocks later migrations by name", () => {
    const migrations = readMigrationFiles({
      migrationsFolder: migrationsDirectory,
    });
    const throughDirectory = (name: string) =>
      migrations.filter((migration) => migration.name <= name);
    const ledgerBeforeBranchAdministration = throughDirectory(
      "20261010010000_organization_member_directory",
    ).map(({ name }, index) => ({
      id: index + 1,
      hash: "",
      created_at: "",
      name,
    }));
    const pendingBeforeFailure = getMigrationsToRun({
      localMigrations: migrations,
      dbMigrations: ledgerBeforeBranchAdministration,
    }).map(({ name }) => name);

    expect(pendingBeforeFailure.slice(0, 3)).toEqual([
      "20261010020000_branch_administration_contract",
      "20261010030000_membership_branch_assignment_contract",
      "20261010040000_branch_permission_backfill_repair",
    ]);

    const ledgerAfterSuccessfulPredecessor = [
      ...ledgerBeforeBranchAdministration,
      {
        id: ledgerBeforeBranchAdministration.length + 1,
        hash: "",
        created_at: "",
        name: "20261010020000_branch_administration_contract",
      },
    ];
    const pendingAfterPredecessor = getMigrationsToRun({
      localMigrations: migrations,
      dbMigrations: ledgerAfterSuccessfulPredecessor,
    }).map(({ name }) => name);
    expect(pendingAfterPredecessor.slice(0, 2)).toEqual([
      "20261010030000_membership_branch_assignment_contract",
      "20261010040000_branch_permission_backfill_repair",
    ]);
  });

  it("restores permissions per tenant for existing Owner/Admin roles and is repeatable", async () => {
    const organizations = await database
      .insert(schema.organizations)
      .values(
        ["Tenant repair A", "Tenant repair B"].map((name) => ({
          name,
          slug: `tenant-repair-${crypto.randomUUID()}`,
          industry: "TEST",
          status: "ACTIVE" as const,
        })),
      )
      .returning();
    const roles = await database
      .insert(schema.roles)
      .values(
        organizations.flatMap((organization) =>
          ["Organization Owner", "Organization Admin"].map((name) => ({
            organizationId: organization.id,
            name,
            description: `${name} role`,
            status: "ACTIVE" as const,
            isSystem: true,
          })),
        ),
      )
      .returning();
    if (organizations.length !== 2 || roles.length !== 4) {
      throw new Error("Test organizations or system roles were not created");
    }

    const [branchReadPermission] = await database
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(sql`${schema.permissions.key} = 'core.organization.branch.read'`)
      .limit(1);
    const existingOwner = roles.find(
      (role) =>
        role.organizationId === organizations[0]?.id &&
        role.name === "Organization Owner",
    );
    if (!branchReadPermission || !existingOwner) {
      throw new Error("Existing permission fixture was not found");
    }
    await database.insert(schema.rolePermissions).values({
      organizationId: existingOwner.organizationId,
      roleId: existingOwner.id,
      permissionId: branchReadPermission.id,
      scopeType: "ORGANIZATION",
    });

    const assignmentMigrationSql = await readFile(
      assignmentMigrationPath,
      "utf8",
    );
    const branchAdministrationMigrationSql = await readFile(
      branchAdministrationMigrationPath,
      "utf8",
    );
    const repairMigrationSql = await readFile(repairMigrationPath, "utf8");

    const rlsRows = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('roles', 'role_permissions')
      ORDER BY relname
    `);
    expect(rlsRows.rows).toHaveLength(2);
    expect(
      rlsRows.rows.every(
        (row) => row.relrowsecurity && row.relforcerowsecurity,
      ),
    ).toBe(true);

    let legacyMigrationFailure: unknown;
    await client.exec("BEGIN");
    try {
      await client.exec("SET LOCAL ROLE onecore_migrator");
      await client.exec(`
        INSERT INTO role_permissions
          (organization_id, role_id, permission_id, scope_type, scope)
        SELECT roles.organization_id, roles.id, permissions.id,
          'ORGANIZATION', '{}'::jsonb
        FROM roles
        JOIN permissions ON permissions.key IN (
          'core.organization.branch.read',
          'core.organization.branch.create',
          'core.organization.branch.update'
        )
        WHERE roles.is_system = true
          AND roles.name IN ('Organization Owner', 'Organization Admin')
        ON CONFLICT (organization_id, role_id, permission_id) DO NOTHING
      `);
      await client.exec("COMMIT");
    } catch (error) {
      legacyMigrationFailure = error;
      await client.exec("ROLLBACK");
    }
    expect(String(legacyMigrationFailure)).toMatch(
      /row-level security policy/i,
    );

    let migrationFailure: unknown;
    await client.exec("BEGIN");
    try {
      await client.exec("SET LOCAL ROLE onecore_migrator");
      for (const statement of branchAdministrationMigrationSql
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await client.exec(statement);
      }
      await client.exec("SELECT 1 / 0");
      await client.exec("COMMIT");
    } catch (error) {
      migrationFailure = error;
      await client.exec("ROLLBACK");
    }
    expect(String(migrationFailure)).toMatch(/division by zero/i);
    for (const organization of organizations) {
      const rolledBackGrants = await database
        .select({ count: sql<number>`count(*)` })
        .from(schema.rolePermissions)
        .where(
          sql`${schema.rolePermissions.organizationId} = ${organization.id}`,
        );
      expect(Number(rolledBackGrants[0]?.count ?? 0)).toBe(
        organization.id === existingOwner.organizationId ? 1 : 0,
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.exec("BEGIN");
      try {
        await client.exec("SET LOCAL ROLE onecore_migrator");
        for (const statement of branchAdministrationMigrationSql
          .split("--> statement-breakpoint")
          .map((value) => value.trim())
          .filter(Boolean)) {
          await client.exec(statement);
        }
        await client.exec("COMMIT");
      } catch (error) {
        await client.exec("ROLLBACK");
        throw error;
      }
    }

    for (const organization of organizations) {
      const branchGrantCount = await database
        .select({ count: sql<number>`count(*)` })
        .from(schema.rolePermissions)
        .where(
          sql`${schema.rolePermissions.organizationId} = ${organization.id}`,
        );
      expect(Number(branchGrantCount[0]?.count ?? 0)).toBe(6);
    }

    await client.exec("BEGIN");
    try {
      await client.exec("SET LOCAL ROLE onecore_migrator");
      for (const statement of assignmentMigrationSql
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await client.exec(statement);
      }
      for (const statement of assignmentMigrationSql
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await client.exec(statement);
      }
      await client.exec(repairMigrationSql);
      await client.exec(repairMigrationSql);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw error;
    }

    for (const organization of organizations) {
      const rows = await database
        .select({ count: sql<number>`count(*)` })
        .from(schema.rolePermissions)
        .where(
          sql`${schema.rolePermissions.organizationId} = ${organization.id}`,
        );
      expect(Number(rows[0]?.count ?? 0)).toBe(12);
    }

    const tenantA = organizations[0];
    const tenantB = organizations[1];
    if (!tenantA || !tenantB) throw new Error("Test tenant was not created");
    const roleGrantRows = await client.query<{
      organization_id: string;
      role_name: string;
      permission_key: string;
      scope_type: string;
      scope: Record<string, unknown>;
    }>(
      `
        SELECT roles.organization_id, roles.name AS role_name,
          permissions.key AS permission_key,
          role_permissions.scope_type, role_permissions.scope
        FROM role_permissions
        JOIN roles
          ON roles.organization_id = role_permissions.organization_id
          AND roles.id = role_permissions.role_id
        JOIN permissions ON permissions.id = role_permissions.permission_id
        WHERE roles.organization_id IN ($1, $2)
          AND roles.name IN ('Organization Owner', 'Organization Admin')
        ORDER BY roles.organization_id, roles.name, permissions.key
    `,
      [tenantA.id, tenantB.id],
    );
    const expectedPermissionKeys = [
      "core.organization.branch.create",
      "core.organization.branch.read",
      "core.organization.branch.update",
      "core.organization.membership_branch.assign",
      "core.organization.membership_branch.read",
      "core.organization.membership_branch.remove",
    ];
    expect(roleGrantRows.rows).toHaveLength(organizations.length * 2 * 6);
    for (const organization of organizations) {
      for (const roleName of ["Organization Owner", "Organization Admin"]) {
        const grants = roleGrantRows.rows.filter(
          (row) =>
            row.organization_id === organization.id &&
            row.role_name === roleName,
        );
        expect(grants.map((grant) => grant.permission_key).sort()).toEqual(
          expectedPermissionKeys,
        );
        expect(
          grants.every(
            (grant) =>
              grant.scope_type === "ORGANIZATION" &&
              Object.keys(grant.scope).length === 0,
          ),
        ).toBe(true);
      }
    }

    const tenantAVisible = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      await transaction.query(
        "SELECT set_config('app.current_organization_id', $1, true)",
        [tenantA.id],
      );
      return transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM role_permissions",
      );
    });
    const tenantBVisible = await client.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL ROLE onecore_app");
      await transaction.query(
        "SELECT set_config('app.current_organization_id', $1, true)",
        [tenantB.id],
      );
      return transaction.query<{ organization_id: string }>(
        "SELECT organization_id FROM role_permissions",
      );
    });
    expect(tenantAVisible.rows.length).toBe(12);
    expect(
      tenantAVisible.rows.every(
        ({ organization_id }) => organization_id === tenantA.id,
      ),
    ).toBe(true);
    expect(tenantBVisible.rows.length).toBe(12);
    expect(
      tenantBVisible.rows.every(
        ({ organization_id }) => organization_id === tenantB.id,
      ),
    ).toBe(true);
  });
});
