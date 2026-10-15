import { describe, expect, it } from "vitest";
import {
  assertConnectedMigrationIdentity,
  assertMigrationDatabaseState,
  MigrationTargetError,
  resolveMigrationTarget,
  type ConnectedMigrationIdentity,
  type MigrationDatabaseState,
} from "../scripts/migration-target.js";

const developmentEnvironment = {
  MIGRATOR_DATABASE_URL:
    "postgresql://onecore_migrator@127.0.0.1:5432/onecore_dev",
  ONECORE_MIGRATION_ENVIRONMENT: "development",
  ONECORE_MIGRATION_EXPECTED_HOST: "127.0.0.1",
  ONECORE_MIGRATION_EXPECTED_PORT: "5432",
  ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_dev",
  NODE_ENV: "development",
};

const validIdentity: ConnectedMigrationIdentity = {
  database_name: "onecore_dev",
  session_user: "onecore_migrator",
  current_role: "onecore_migrator",
  is_superuser: false,
  bypasses_rls: false,
  can_create_database: false,
  can_create_roles: false,
  can_replicate: false,
  owns_database: false,
  inherits_roles: true,
  role_memberships: [],
  can_connect: true,
  can_create_schema: true,
  can_use_public_schema: true,
  can_create_public_schema: true,
  search_path: "public",
  current_schema: "public",
  effective_schemas: ["public"],
  non_owned_application_objects: 0,
  drizzle_schema_owner: null,
};

const emptyDatabaseState: MigrationDatabaseState = {
  application_object_count: 0,
  unexpected_schemas: [],
  ledger_candidates: [],
  ledger_schema_exists: false,
  ledger_schema_owner: null,
  ledger_table_exists: false,
  ledger_table_owner: null,
  ledger_columns: [],
  drizzle_other_object_count: 0,
};

describe("migration target safety", () => {
  it("requires a valid URL and explicit environment-specific target", () => {
    expect(() => resolveMigrationTarget({})).toThrow(
      "MIGRATOR_DATABASE_URL is required",
    );
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL: undefined,
        DATABASE_URL:
          "postgresql://onecore_app@127.0.0.1:5432/onecore_dev",
      }),
    ).toThrow("MIGRATOR_DATABASE_URL is required");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL: " \t ",
      }),
    ).toThrow("MIGRATOR_DATABASE_URL is required");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL: "not a connection URL that contains secret material",
      }),
    ).toThrow("not a valid PostgreSQL connection URL");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL: "https://example.test/database",
      }),
    ).toThrow("postgres or postgresql protocol");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        ONECORE_MIGRATION_ENVIRONMENT: undefined,
      }),
    ).toThrow("ONECORE_MIGRATION_ENVIRONMENT");
  });

  it("requires the migrator login and rejects target host, port, and database mismatches", () => {
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL:
          "postgresql://onecore_app@127.0.0.1:5432/onecore_dev",
      }),
    ).toThrow("dedicated migration role");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        ONECORE_MIGRATION_EXPECTED_HOST: "localhost",
      }),
    ).toThrow("does not match");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        ONECORE_MIGRATION_EXPECTED_PORT: "5433",
      }),
    ).toThrow("does not match");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_test",
      }),
    ).toThrow("does not match");
  });

  it("selects the explicit migrator URL and never falls back to the runtime URL", () => {
    const migratorUrl =
      "postgresql://onecore_migrator@127.0.0.1:5432/onecore_dev";
    const runtimeUrl =
      "postgresql://onecore_app@127.0.0.1:5432/onecore_dev";
    expect(
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL: migratorUrl,
        DATABASE_URL: runtimeUrl,
      }).connectionString,
    ).toBe(migratorUrl);
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL: undefined,
        DATABASE_URL: runtimeUrl,
      }),
    ).toThrow("MIGRATOR_DATABASE_URL is required");
  });

  it("rejects a wrong migrator role without exposing URL credentials", () => {
    const password = "synthetic-test-password";
    const invalidUrl = `postgresql://onecore_app:${password}@127.0.0.1:5432/onecore_dev`;
    let error: unknown;
    try {
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL: invalidUrl,
        DATABASE_URL:
          "postgresql://onecore_migrator@127.0.0.1:5432/onecore_dev",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MigrationTargetError);
    expect((error as Error).message).toContain("dedicated migration role");
    expect((error as Error).message).not.toContain("onecore_app");
    expect((error as Error).message).not.toContain(password);
    expect((error as Error).message).not.toContain(invalidUrl);
  });

  it("allows an explicitly matched loopback development target", () => {
    expect(resolveMigrationTarget(developmentEnvironment)).toMatchObject({
      database: "onecore_dev",
      environment: "development",
      host: "127.0.0.1",
      port: 5432,
      role: "onecore_migrator",
      connectionString: developmentEnvironment.MIGRATOR_DATABASE_URL,
    });
  });

  it("rejects remote development/test targets and environment ambiguity", () => {
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL:
          "postgresql://onecore_migrator:local@db.example.test:5432/onecore_dev",
        ONECORE_MIGRATION_EXPECTED_HOST: "db.example.test",
      }),
    ).toThrow("restricted to loopback");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        MIGRATOR_DATABASE_URL:
          "postgresql://onecore_migrator:local@127.0.0.1:5432/onecore_prod",
        ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_prod",
      }),
    ).toThrow("production-named");
    expect(() =>
      resolveMigrationTarget({
        ...developmentEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow("must agree");
  });

  it("requires exact remote target identity and explicit production confirmation", () => {
    const productionEnvironment = {
      MIGRATOR_DATABASE_URL:
        "postgresql://onecore_migrator@db.example.test:5432/onecore_prod",
      ONECORE_MIGRATION_ENVIRONMENT: "production",
      ONECORE_MIGRATION_EXPECTED_HOST: "db.example.test",
      ONECORE_MIGRATION_EXPECTED_PORT: "5432",
      ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_prod",
      ONECORE_MIGRATION_EXPECTED_RESOURCE_ID: "provider-resource-123",
      NODE_ENV: "production",
    };
    expect(() => resolveMigrationTarget(productionEnvironment)).toThrow(
      "ONECORE_MIGRATION_CONFIRM_PRODUCTION",
    );
    expect(
      resolveMigrationTarget({
        ...productionEnvironment,
        ONECORE_MIGRATION_CONFIRM_PRODUCTION:
          "provider-resource-123/onecore_prod",
      }),
    ).toMatchObject({
      environment: "production",
      resourceId: "provider-resource-123",
    });
    expect(() =>
      resolveMigrationTarget({
        ...productionEnvironment,
        ONECORE_MIGRATION_CONFIRM_PRODUCTION:
          "provider-resource-456/onecore_prod",
      }),
    ).toThrow("must equal");
    expect(() =>
      resolveMigrationTarget({
        ...productionEnvironment,
        ONECORE_MIGRATION_EXPECTED_PORT: "5433",
        ONECORE_MIGRATION_CONFIRM_PRODUCTION:
          "provider-resource-123/onecore_prod",
      }),
    ).toThrow("does not match");
  });

  it.each([
    ["superuser", { is_superuser: true }],
    ["RLS bypass", { bypasses_rls: true }],
    ["CREATEDB", { can_create_database: true }],
    ["CREATEROLE", { can_create_roles: true }],
    ["REPLICATION", { can_replicate: true }],
    ["database ownership", { owns_database: true }],
    ["role membership", { role_memberships: ["unrelated_role"] }],
    ["missing database CREATE", { can_create_schema: false }],
    ["missing schema CREATE", { can_create_public_schema: false }],
    ["missing schema USAGE", { can_use_public_schema: false }],
    ["ambiguous search_path", { search_path: '"$user", public' }],
    ["wrong schema", { current_schema: "other" }],
    ["unexpected search_path", { effective_schemas: ["public", "other"] }],
    ["foreign-owned objects", { non_owned_application_objects: 1 }],
    ["foreign metadata owner", { drizzle_schema_owner: "other_role" }],
  ])("rejects unsafe connected identity: %s", (_name, override) => {
    const target = resolveMigrationTarget(developmentEnvironment);
    expect(() =>
      assertConnectedMigrationIdentity(
        { ...validIdentity, ...override },
        target,
      ),
    ).toThrow(MigrationTargetError);
  });

  it("accepts only a complete least-privilege connected migration identity", () => {
    const target = resolveMigrationTarget(developmentEnvironment);
    expect(() =>
      assertConnectedMigrationIdentity(validIdentity, target),
    ).not.toThrow();
    expect(() =>
      assertConnectedMigrationIdentity(
        { ...validIdentity, database_name: "another_database" },
        target,
      ),
    ).toThrow("does not match");
    expect(() =>
      assertConnectedMigrationIdentity(
        { current_role: "onecore_migrator" },
        target,
      ),
    ).toThrow("complete");
  });

  it("rejects noncanonical, malformed, or foreign-owned ledger metadata", () => {
    const target = resolveMigrationTarget(developmentEnvironment);
    expect(() =>
      assertMigrationDatabaseState(
        {
          ...emptyDatabaseState,
          ledger_candidates: ["other.__drizzle_migrations"],
        },
        target,
      ),
    ).toThrow("outside the configured");
    expect(() =>
      assertMigrationDatabaseState(
        {
          ...emptyDatabaseState,
          ledger_schema_exists: true,
          ledger_schema_owner: "other_role",
        },
        target,
      ),
    ).toThrow("metadata schema");
    expect(() =>
      assertMigrationDatabaseState(
        {
          ...emptyDatabaseState,
          ledger_candidates: ["drizzle.__drizzle_migrations"],
        },
        target,
      ),
    ).toThrow("not a supported table");
    expect(() =>
      assertMigrationDatabaseState(
        {
          ...emptyDatabaseState,
          ledger_table_exists: true,
          ledger_table_owner: "onecore_migrator",
          ledger_columns: [{ name: "hash", data_type: "text" }],
        },
        target,
      ),
    ).toThrow("malformed schema");
  });
});
