import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MigrationHistoryError } from "./migration-history.js";
import { readUncommittedMigrationNames } from "./migration-git-state.js";
import {
  MigrationTargetError,
  type MigrationDatabaseState,
} from "./migration-target.js";
import {
  MigrationExecutionError,
  runMigration,
  type MigrationConnection,
  type MigrationInspection,
} from "./migration-runner.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(scriptDirectory, "../migrations");

function rowRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  throw new Error(`PostgreSQL returned an invalid ${label} row`);
}

function parseLedgerColumns(
  rows: Iterable<unknown>,
): MigrationDatabaseState["ledger_columns"] {
  return Array.from(rows, (value) => {
    const row = rowRecord(value, "migration ledger column");
    if (typeof row.name !== "string" || typeof row.data_type !== "string") {
      throw new Error("PostgreSQL returned malformed migration ledger columns");
    }
    return { name: row.name, data_type: row.data_type };
  });
}

function parseLedgerRows(
  rows: Iterable<unknown>,
): MigrationInspection["ledger"] {
  return Array.from(rows, (value) => {
    const row = rowRecord(value, "migration ledger");
    if (
      !(typeof row.id === "number" || typeof row.id === "string") ||
      !(typeof row.hash === "string" || row.hash === null) ||
      !(
        typeof row.created_at === "number" ||
        typeof row.created_at === "string" ||
        row.created_at === null
      ) ||
      !(typeof row.name === "string" || row.name === null)
    ) {
      throw new Error("PostgreSQL returned malformed migration ledger records");
    }
    return {
      id: row.id,
      hash: row.hash,
      created_at: row.created_at,
      name: row.name,
    };
  });
}

class PostgresMigrationConnection implements MigrationConnection {
  private readonly client: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    this.client = postgres(connectionString, { max: 1 });
  }

  async applyMigrations(migrationsPath: string): Promise<void> {
    await migrate(drizzle({ client: this.client }), {
      migrationsFolder: migrationsPath,
    });
  }

  async inspect(): Promise<MigrationInspection> {
    return this.client.begin(async (transaction) => {
      await transaction`SET TRANSACTION READ ONLY`;

      const [identity] = await transaction`
        SELECT current_database() AS database_name,
               session_user AS session_user,
               current_user AS current_role,
               role.rolsuper AS is_superuser,
               role.rolbypassrls AS bypasses_rls,
               role.rolcreatedb AS can_create_database,
               role.rolcreaterole AS can_create_roles,
               role.rolreplication AS can_replicate,
               db_catalog.datdba = role.oid AS owns_database,
               role.rolinherit AS inherits_roles,
               has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
               has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
               has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public_schema,
               has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public_schema,
               current_setting('search_path') AS search_path,
               current_schema() AS current_schema,
               current_schemas(false)::text[] AS effective_schemas,
               COALESCE((
                 SELECT array_agg(member.rolname ORDER BY member.rolname)
                 FROM pg_catalog.pg_roles AS member
                 WHERE member.oid <> role.oid
                   AND pg_catalog.pg_has_role(role.oid, member.oid, 'MEMBER')
               ), ARRAY[]::text[]) AS role_memberships,
               (
                 SELECT count(*)::integer
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS schema
                   ON schema.oid = relation.relnamespace
                 WHERE schema.nspname = 'public'
                   AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
                   AND relation.relowner <> role.oid
               ) + (
                 SELECT count(*)::integer
                 FROM pg_catalog.pg_proc AS routine
                 JOIN pg_catalog.pg_namespace AS schema
                   ON schema.oid = routine.pronamespace
                 WHERE schema.nspname = 'public'
                   AND routine.proowner <> role.oid
               ) AS non_owned_application_objects,
               (
                 SELECT pg_catalog.pg_get_userbyid(schema.nspowner)
                 FROM pg_catalog.pg_namespace AS schema
                 WHERE schema.nspname = 'drizzle'
               ) AS drizzle_schema_owner
        FROM pg_catalog.pg_roles AS role
        JOIN pg_catalog.pg_database AS db_catalog
          ON db_catalog.datname = current_database()
        WHERE role.rolname = current_user
      `;

      const [databaseState] = await transaction`
        SELECT (
                 SELECT count(*)::integer
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS schema
                   ON schema.oid = relation.relnamespace
                 WHERE schema.nspname !~ '^pg_'
                   AND schema.nspname <> 'information_schema'
                   AND NOT (
                     schema.nspname = 'drizzle'
                     AND relation.relname = '__drizzle_migrations'
                   )
                   AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
               ) AS application_object_count,
               COALESCE((
                 SELECT array_agg(schema.nspname ORDER BY schema.nspname)
                 FROM pg_catalog.pg_namespace AS schema
                 WHERE schema.nspname !~ '^pg_'
                   AND schema.nspname NOT IN (
                     'information_schema',
                     'public',
                     'drizzle'
                   )
               ), ARRAY[]::text[]) AS unexpected_schemas,
               COALESCE((
                 SELECT array_agg(schema.nspname || '.' || relation.relname)
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS schema
                   ON schema.oid = relation.relnamespace
                 WHERE relation.relname = '__drizzle_migrations'
               ), ARRAY[]::text[]) AS ledger_candidates,
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_namespace AS schema
                 WHERE schema.nspname = 'drizzle'
               ) AS ledger_schema_exists,
               (
                 SELECT pg_catalog.pg_get_userbyid(schema.nspowner)
                 FROM pg_catalog.pg_namespace AS schema
                 WHERE schema.nspname = 'drizzle'
               ) AS ledger_schema_owner,
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS schema
                   ON schema.oid = relation.relnamespace
                 WHERE schema.nspname = 'drizzle'
                   AND relation.relname = '__drizzle_migrations'
                   AND relation.relkind IN ('r', 'p')
               ) AS ledger_table_exists,
               (
                 SELECT pg_catalog.pg_get_userbyid(relation.relowner)
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS schema
                   ON schema.oid = relation.relnamespace
                 WHERE schema.nspname = 'drizzle'
                   AND relation.relname = '__drizzle_migrations'
                   AND relation.relkind IN ('r', 'p')
               ) AS ledger_table_owner,
               (
                 SELECT count(*)::integer
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS schema
                   ON schema.oid = relation.relnamespace
                 WHERE schema.nspname = 'drizzle'
                   AND relation.relname <> '__drizzle_migrations'
                   AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
               ) AS drizzle_other_object_count
      `;

      let ledgerColumns: MigrationDatabaseState["ledger_columns"] = [];
      let ledger: MigrationInspection["ledger"] = null;
      const databaseStateRow = rowRecord(databaseState, "database metadata");
      if (databaseStateRow.ledger_table_exists === true) {
        const columnRows = await transaction`
          SELECT column_name AS name, data_type
          FROM information_schema.columns
          WHERE table_schema = 'drizzle'
            AND table_name = '__drizzle_migrations'
          ORDER BY ordinal_position
        `;
        ledgerColumns = parseLedgerColumns(columnRows);
        const ledgerRows = await transaction`
          SELECT id, hash, created_at, name
          FROM drizzle.__drizzle_migrations
          ORDER BY id
        `;
        ledger = parseLedgerRows(ledgerRows);
      }

      return {
        identity,
        databaseState: Object.assign({}, databaseStateRow, {
          ledger_columns: ledgerColumns,
        }),
        ledger,
      };
    });
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

function parseArguments(arguments_: string[]): boolean {
  if (arguments_.some((argument) => argument !== "--validate-only")) {
    throw new MigrationTargetError(
      "Supported migration option: --validate-only",
    );
  }
  return arguments_.includes("--validate-only");
}

async function main(): Promise<void> {
  const validateOnly = parseArguments(process.argv.slice(2));
  try {
    await runMigration(
      {
        environment: process.env,
        migrationsFolder,
        validateOnly,
      },
      {
        connect: async (connectionString) =>
          new PostgresMigrationConnection(connectionString),
        migrate: async (connection, folder) => {
          if (!(connection instanceof PostgresMigrationConnection)) {
            throw new Error("Invalid PostgreSQL migration connection");
          }
          await connection.applyMigrations(folder);
        },
        readUncommittedMigrationNames,
        log: (message) => console.info(message),
      },
    );
  } catch (error) {
    if (
      error instanceof MigrationTargetError ||
      error instanceof MigrationHistoryError ||
      error instanceof MigrationExecutionError
    ) {
      console.error(error.message);
    } else {
      const errorCode =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z0-9]{1,10}$/.test(error.code)
          ? error.code
          : undefined;
      console.error(
        errorCode
          ? `Migration stopped or failed (error code: ${errorCode}); sensitive diagnostic details were suppressed.`
          : "Migration stopped or failed; sensitive diagnostic details were suppressed.",
      );
    }
    process.exitCode = 1;
  }
}

await main();
