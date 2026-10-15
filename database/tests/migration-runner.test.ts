import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMigrationFiles } from "../scripts/migration-history.js";
import {
  runMigration,
  type MigrationConnection,
  type MigrationInspection,
} from "../scripts/migration-runner.js";
import type {
  ConnectedMigrationIdentity,
  MigrationDatabaseState,
} from "../scripts/migration-target.js";

const environment = {
  MIGRATOR_DATABASE_URL:
    "postgresql://onecore_migrator@127.0.0.1:5432/onecore_test",
  ONECORE_MIGRATION_ENVIRONMENT: "test",
  ONECORE_MIGRATION_EXPECTED_HOST: "127.0.0.1",
  ONECORE_MIGRATION_EXPECTED_PORT: "5432",
  ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_test",
  NODE_ENV: "test",
};

const identity: ConnectedMigrationIdentity = {
  database_name: "onecore_test",
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

describe("migration runner", () => {
  let migrationsFolder: string;

  beforeEach(async () => {
    migrationsFolder = await mkdtemp(
      join(tmpdir(), "onecore-migration-runner-"),
    );
    await addMigration("20261001000000_first", "SELECT 1;");
    await addMigration("20261002000000_second", "SELECT 2;");
  });

  afterEach(async () => {
    await rm(migrationsFolder, { recursive: true, force: true });
  });

  async function addMigration(name: string, sql: string): Promise<void> {
    const directory = join(migrationsFolder, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "migration.sql"), sql);
  }

  async function makeDependencies(
    inspection: MigrationInspection,
    overrides: Partial<{
      migrate: (
        connection: MigrationConnection,
        folder: string,
      ) => Promise<void>;
      uncommitted: string[];
      onClose: () => void;
    }> = {},
  ) {
    const close = vi.fn(async () => overrides.onClose?.());
    const connect = vi.fn(async () => ({
      inspect: async () => inspection,
      close,
    }));
    const migrate = vi.fn(overrides.migrate ?? (async () => undefined));
    const log = vi.fn();
    return {
      dependencies: {
        connect,
        migrate,
        readUncommittedMigrationNames: async () => overrides.uncommitted ?? [],
        log,
      },
      close,
      connect,
      migrate,
      log,
    };
  }

  function inspection(
    overrides: Partial<MigrationInspection> = {},
  ): MigrationInspection {
    return {
      identity,
      databaseState: emptyDatabaseState,
      ledger: [],
      ...overrides,
    };
  }

  it("validation-only inspects files and ledger but never invokes the migrator", async () => {
    const mocks = await makeDependencies(inspection());

    await runMigration(
      { environment, migrationsFolder, validateOnly: true },
      mocks.dependencies,
    );

    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledWith(environment.MIGRATOR_DATABASE_URL);
    expect(mocks.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "No migration SQL or ledger writes were executed",
      ),
    );
  });

  it("rejects runtime DATABASE_URL without MIGRATOR_DATABASE_URL before connecting", async () => {
    const mocks = await makeDependencies(inspection());
    const runtimeOnlyEnvironment = {
      ...environment,
      MIGRATOR_DATABASE_URL: undefined,
      DATABASE_URL: "postgresql://onecore_app@127.0.0.1:5432/onecore_test",
    };

    await expect(
      runMigration(
        {
          environment: runtimeOnlyEnvironment,
          migrationsFolder,
          validateOnly: true,
        },
        mocks.dependencies,
      ),
    ).rejects.toThrow("MIGRATOR_DATABASE_URL is required");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a mismatched migration target before connecting", async () => {
    const mocks = await makeDependencies(inspection());

    await expect(
      runMigration(
        {
          environment: {
            ...environment,
            ONECORE_MIGRATION_EXPECTED_DATABASE: "another_test_database",
          },
          migrationsFolder,
          validateOnly: false,
        },
        mocks.dependencies,
      ),
    ).rejects.toThrow("does not match");

    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it("stops on preflight identity failure before migration and closes the connection", async () => {
    const mocks = await makeDependencies(
      inspection({ identity: { ...identity, is_superuser: true } }),
    );

    await expect(
      runMigration(
        { environment, migrationsFolder, validateOnly: false },
        mocks.dependencies,
      ),
    ).rejects.toThrow("NOSUPERUSER");

    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("stops on ambiguous migration history without invoking Drizzle", async () => {
    const migrations = await readMigrationFiles(migrationsFolder);
    const mocks = await makeDependencies(
      inspection({
        databaseState: { ...emptyDatabaseState, application_object_count: 1 },
        ledger: [
          {
            id: 1,
            hash: migrations[1]!.hash,
            created_at: migrations[1]!.timestamp,
            name: migrations[1]!.name,
          },
        ],
      }),
    );

    await expect(
      runMigration(
        { environment, migrationsFolder, validateOnly: false },
        mocks.dependencies,
      ),
    ).rejects.toThrow("history mismatch");

    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("requires explicit review for uncommitted migrations before connecting", async () => {
    const mocks = await makeDependencies(inspection(), {
      uncommitted: ["20261014150000_initial_superadmin_bootstrap"],
    });

    await expect(
      runMigration(
        { environment, migrationsFolder, validateOnly: true },
        mocks.dependencies,
      ),
    ).rejects.toThrow("require explicit review");

    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("allows an explicitly reviewed uncommitted migration only in local/test mode", async () => {
    const mocks = await makeDependencies(inspection(), {
      uncommitted: ["20261014150000_initial_superadmin_bootstrap"],
    });
    const reviewedEnvironment = {
      ...environment,
      ONECORE_MIGRATION_REVIEWED_UNTRACKED:
        "20261014150000_initial_superadmin_bootstrap",
    };

    await runMigration(
      {
        environment: reviewedEnvironment,
        migrationsFolder,
        validateOnly: true,
      },
      mocks.dependencies,
    );

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it("reports possible partial metadata on migration failure and closes the connection", async () => {
    const mocks = await makeDependencies(inspection(), {
      migrate: async () => {
        throw new Error("test failure");
      },
    });

    await expect(
      runMigration(
        { environment, migrationsFolder, validateOnly: false },
        mocks.dependencies,
      ),
    ).rejects.toThrow(
      "verify the target read-only before retrying and never repair the ledger manually",
    );

    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("requires explicit approval before initializing an empty production database", async () => {
    const productionEnvironment = {
      MIGRATOR_DATABASE_URL:
        "postgresql://onecore_migrator@db.example.test:5432/onecore_prod",
      ONECORE_MIGRATION_ENVIRONMENT: "production",
      ONECORE_MIGRATION_EXPECTED_HOST: "db.example.test",
      ONECORE_MIGRATION_EXPECTED_PORT: "5432",
      ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_prod",
      ONECORE_MIGRATION_EXPECTED_RESOURCE_ID: "verified-resource",
      ONECORE_MIGRATION_CONFIRM_PRODUCTION: "verified-resource/onecore_prod",
      NODE_ENV: "production",
    };
    const mocks = await makeDependencies(
      inspection({
        identity: { ...identity, database_name: "onecore_prod" },
      }),
    );

    await expect(
      runMigration(
        {
          environment: productionEnvironment,
          migrationsFolder,
          validateOnly: true,
        },
        mocks.dependencies,
      ),
    ).rejects.toThrow("INITIALIZE_EMPTY_DATABASE");

    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("rejects uncommitted migrations in production even when locally reviewed", async () => {
    const productionEnvironment = {
      MIGRATOR_DATABASE_URL:
        "postgresql://onecore_migrator@db.example.test:5432/onecore_prod",
      ONECORE_MIGRATION_ENVIRONMENT: "production",
      ONECORE_MIGRATION_EXPECTED_HOST: "db.example.test",
      ONECORE_MIGRATION_EXPECTED_PORT: "5432",
      ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_prod",
      ONECORE_MIGRATION_EXPECTED_RESOURCE_ID: "verified-resource",
      ONECORE_MIGRATION_CONFIRM_PRODUCTION: "verified-resource/onecore_prod",
      ONECORE_MIGRATION_REVIEWED_UNTRACKED:
        "20261014150000_initial_superadmin_bootstrap",
      NODE_ENV: "production",
    };
    const mocks = await makeDependencies(inspection(), {
      uncommitted: ["20261014150000_initial_superadmin_bootstrap"],
    });

    await expect(
      runMigration(
        {
          environment: productionEnvironment,
          migrationsFolder,
          validateOnly: true,
        },
        mocks.dependencies,
      ),
    ).rejects.toThrow("committed, clean migration files");

    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
