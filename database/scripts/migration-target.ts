export type MigrationEnvironment =
  "development" | "test" | "staging" | "production";

export interface MigrationTarget {
  connectionString: string;database/migrations/20261010201153_inventory_reservation_foundation/migration.sql
  
  database: string;
  environment: MigrationEnvironment;
  host: string;
  port: number;
  resourceId?: string;
  role: "onecore_migrator";
}

export interface ConnectedMigrationIdentity {
  database_name: string;
  session_user: string;
  current_role: string;
  is_superuser: boolean;
  bypasses_rls: boolean;
  can_create_database: boolean;
  can_create_roles: boolean;
  can_replicate: boolean;
  owns_database: boolean;
  inherits_roles: boolean;
  role_memberships: string[];
  can_connect: boolean;
  can_create_schema: boolean;
  can_use_public_schema: boolean;
  can_create_public_schema: boolean;
  search_path: string;
  current_schema: string | null;
  effective_schemas: string[];
  non_owned_application_objects: number;
  drizzle_schema_owner: string | null;
}

export interface MigrationDatabaseState {
  application_object_count: number;
  unexpected_schemas: string[];
  ledger_candidates: string[];
  ledger_schema_exists: boolean;
  ledger_schema_owner: string | null;
  ledger_table_exists: boolean;
  ledger_table_owner: string | null;
  ledger_columns: Array<{ name: string; data_type: string }>;
  drizzle_other_object_count: number;
}

export class MigrationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationTargetError";
  }
}

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MigrationTargetError(
      `MIGRATOR_DATABASE_URL has invalid encoding in its ${label}`,
    );
  }
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new MigrationTargetError(`${name} is required to migrate`);
  }
  return value;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function parseEnvironment(value: string): MigrationEnvironment {
  if (
    value === "development" ||
    value === "test" ||
    value === "staging" ||
    value === "production"
  ) {
    return value;
  }
  throw new MigrationTargetError(
    "ONECORE_MIGRATION_ENVIRONMENT must be development, test, staging, or production",
  );
}

export function resolveMigrationTarget(
  environment: NodeJS.ProcessEnv,
): MigrationTarget {
  const configuredConnectionString = environment.MIGRATOR_DATABASE_URL;
  if (!configuredConnectionString?.trim()) {
    throw new MigrationTargetError(
      "MIGRATOR_DATABASE_URL is required to migrate",
    );
  }
  const connectionString = configuredConnectionString.trim();

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new MigrationTargetError(
      "MIGRATOR_DATABASE_URL is not a valid PostgreSQL connection URL",
    );
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new MigrationTargetError(
      "MIGRATOR_DATABASE_URL must use the postgres or postgresql protocol",
    );
  }
  if (url.hash) {
    throw new MigrationTargetError(
      "MIGRATOR_DATABASE_URL must not contain a URL fragment",
    );
  }

  const role = decodeUrlComponent(url.username, "username");
  if (role !== "onecore_migrator") {
    throw new MigrationTargetError(
      "MIGRATOR_DATABASE_URL must authenticate as the dedicated migration role",
    );
  }

  const database = decodeUrlComponent(
    url.pathname.replace(/^\/+/, ""),
    "database name",
  );
  const host = url.hostname;
  const port = url.port === "" ? 5432 : Number(url.port);
  if (
    !host ||
    !database ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new MigrationTargetError(
      "MIGRATOR_DATABASE_URL must include a valid host, port, and database name",
    );
  }

  const migrationEnvironment = parseEnvironment(
    requiredEnvironmentValue(environment, "ONECORE_MIGRATION_ENVIRONMENT"),
  );
  if (
    (environment.NODE_ENV === "production" &&
      (migrationEnvironment === "development" ||
        migrationEnvironment === "test")) ||
    (migrationEnvironment === "production" &&
      environment.NODE_ENV !== "production") ||
    (environment.NODE_ENV === "development" &&
      migrationEnvironment !== "development") ||
    (environment.NODE_ENV === "test" && migrationEnvironment !== "test")
  ) {
    throw new MigrationTargetError(
      "ONECORE_MIGRATION_ENVIRONMENT must agree with NODE_ENV",
    );
  }
  const expectedHost = requiredEnvironmentValue(
    environment,
    "ONECORE_MIGRATION_EXPECTED_HOST",
  );
  const expectedDatabase = requiredEnvironmentValue(
    environment,
    "ONECORE_MIGRATION_EXPECTED_DATABASE",
  );
  const expectedPortValue = requiredEnvironmentValue(
    environment,
    "ONECORE_MIGRATION_EXPECTED_PORT",
  );
  const expectedPort = Number(expectedPortValue);
  if (
    !Number.isInteger(expectedPort) ||
    expectedPort < 1 ||
    expectedPort > 65535
  ) {
    throw new MigrationTargetError(
      "ONECORE_MIGRATION_EXPECTED_PORT must be an integer from 1 to 65535",
    );
  }
  if (
    normalizeHost(expectedHost) !== normalizeHost(host) ||
    expectedDatabase !== database ||
    expectedPort !== port
  ) {
    throw new MigrationTargetError(
      "MIGRATOR_DATABASE_URL does not match the configured migration host, port, and database",
    );
  }

  const resourceId =
    migrationEnvironment === "staging" || migrationEnvironment === "production"
      ? requiredEnvironmentValue(
          environment,
          "ONECORE_MIGRATION_EXPECTED_RESOURCE_ID",
        )
      : undefined;

  if (
    migrationEnvironment === "development" ||
    migrationEnvironment === "test"
  ) {
    if (!isLoopbackHost(host)) {
      throw new MigrationTargetError(
        "Development and test migrations are restricted to loopback PostgreSQL hosts",
      );
    }
    if (/(^|[_-])(prod|production)([_-]|$)/i.test(database)) {
      throw new MigrationTargetError(
        "A production-named database cannot use a development or test migration environment",
      );
    }
  }

  if (migrationEnvironment === "production") {
    const confirmation = requiredEnvironmentValue(
      environment,
      "ONECORE_MIGRATION_CONFIRM_PRODUCTION",
    );
    if (confirmation !== `${resourceId}/${database}`) {
      throw new MigrationTargetError(
        "ONECORE_MIGRATION_CONFIRM_PRODUCTION must equal the verified resource ID and database",
      );
    }
  }

  return {
    connectionString,
    database,
    environment: migrationEnvironment,
    host,
    port,
    ...(resourceId ? { resourceId } : {}),
    role: "onecore_migrator",
  };
}

function isConnectedMigrationIdentity(
  value: unknown,
): value is ConnectedMigrationIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.database_name === "string" &&
    typeof identity.session_user === "string" &&
    typeof identity.current_role === "string" &&
    typeof identity.is_superuser === "boolean" &&
    typeof identity.bypasses_rls === "boolean" &&
    typeof identity.can_create_database === "boolean" &&
    typeof identity.can_create_roles === "boolean" &&
    typeof identity.can_replicate === "boolean" &&
    typeof identity.owns_database === "boolean" &&
    typeof identity.inherits_roles === "boolean" &&
    Array.isArray(identity.role_memberships) &&
    identity.role_memberships.every((role) => typeof role === "string") &&
    typeof identity.can_connect === "boolean" &&
    typeof identity.can_create_schema === "boolean" &&
    typeof identity.can_use_public_schema === "boolean" &&
    typeof identity.can_create_public_schema === "boolean" &&
    typeof identity.search_path === "string" &&
    (typeof identity.current_schema === "string" ||
      identity.current_schema === null) &&
    Array.isArray(identity.effective_schemas) &&
    identity.effective_schemas.every((schema) => typeof schema === "string") &&
    typeof identity.non_owned_application_objects === "number" &&
    (typeof identity.drizzle_schema_owner === "string" ||
      identity.drizzle_schema_owner === null)
  );
}

export function assertConnectedMigrationIdentity(
  value: unknown,
  target: MigrationTarget,
): asserts value is ConnectedMigrationIdentity {
  if (!isConnectedMigrationIdentity(value)) {
    throw new MigrationTargetError(
      "PostgreSQL did not return complete migration-role and schema identity",
    );
  }
  if (
    value.current_role !== target.role ||
    value.session_user !== target.role ||
    value.database_name !== target.database
  ) {
    throw new MigrationTargetError(
      "Connected PostgreSQL identity does not match the configured migration target",
    );
  }
  if (
    value.is_superuser ||
    value.bypasses_rls ||
    value.can_create_database ||
    value.can_create_roles ||
    value.can_replicate ||
    value.owns_database
  ) {
    throw new MigrationTargetError(
      "The migration role must be NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, and not own the database",
    );
  }
  if (value.role_memberships.length > 0) {
    throw new MigrationTargetError(
      "The migration role must not inherit privileges through role memberships",
    );
  }
  if (
    !value.can_connect ||
    !value.can_create_schema ||
    !value.can_use_public_schema ||
    !value.can_create_public_schema
  ) {
    throw new MigrationTargetError(
      "The migration role requires CONNECT, database CREATE, and USAGE/CREATE on public",
    );
  }
  if (
    value.search_path.trim() !== "public" ||
    value.current_schema !== "public" ||
    value.effective_schemas.length !== 1 ||
    value.effective_schemas[0] !== "public"
  ) {
    throw new MigrationTargetError(
      "Migration search_path must be exactly public and resolve only to that schema",
    );
  }
  if (value.non_owned_application_objects > 0) {
    throw new MigrationTargetError(
      "Existing application objects are not owned by onecore_migrator",
    );
  }
  if (
    value.drizzle_schema_owner !== null &&
    value.drizzle_schema_owner !== target.role
  ) {
    throw new MigrationTargetError(
      "The existing Drizzle metadata schema is not owned by onecore_migrator",
    );
  }
}

function isMigrationDatabaseState(
  value: unknown,
): value is MigrationDatabaseState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.application_object_count === "number" &&
    Array.isArray(state.unexpected_schemas) &&
    state.unexpected_schemas.every((schema) => typeof schema === "string") &&
    Array.isArray(state.ledger_candidates) &&
    state.ledger_candidates.every(
      (candidate) => typeof candidate === "string",
    ) &&
    typeof state.ledger_schema_exists === "boolean" &&
    (typeof state.ledger_schema_owner === "string" ||
      state.ledger_schema_owner === null) &&
    typeof state.ledger_table_exists === "boolean" &&
    (typeof state.ledger_table_owner === "string" ||
      state.ledger_table_owner === null) &&
    Array.isArray(state.ledger_columns) &&
    state.ledger_columns.every(
      (column) =>
        typeof column === "object" &&
        column !== null &&
        "name" in column &&
        typeof column.name === "string" &&
        "data_type" in column &&
        typeof column.data_type === "string",
    ) &&
    typeof state.drizzle_other_object_count === "number"
  );
}

export function assertMigrationDatabaseState(
  value: unknown,
  target: MigrationTarget,
): asserts value is MigrationDatabaseState {
  if (!isMigrationDatabaseState(value)) {
    throw new MigrationTargetError(
      "PostgreSQL did not return complete migration metadata state",
    );
  }
  const state = value;
  if (state.unexpected_schemas.length > 0) {
    throw new MigrationTargetError(
      "Unexpected non-system schemas are present; review the target before migrating",
    );
  }
  if (
    state.ledger_candidates.some(
      (candidate) => candidate !== "drizzle.__drizzle_migrations",
    )
  ) {
    throw new MigrationTargetError(
      "A migration ledger candidate exists outside the configured Drizzle ledger",
    );
  }
  if (state.ledger_schema_exists && state.ledger_schema_owner !== target.role) {
    throw new MigrationTargetError(
      "The Drizzle metadata schema must be owned by onecore_migrator",
    );
  }
  if (state.ledger_table_exists && state.ledger_table_owner !== target.role) {
    throw new MigrationTargetError(
      "The Drizzle migration ledger must be owned by onecore_migrator",
    );
  }
  if (
    state.ledger_candidates.includes("drizzle.__drizzle_migrations") &&
    !state.ledger_table_exists
  ) {
    throw new MigrationTargetError(
      "The configured Drizzle ledger name exists but is not a supported table",
    );
  }
  if (state.drizzle_other_object_count > 0) {
    throw new MigrationTargetError(
      "Unexpected objects exist in the Drizzle metadata schema",
    );
  }

  const expectedColumns = new Map([
    ["id", "integer"],
    ["hash", "text"],
    ["created_at", "bigint"],
    ["name", "text"],
  ]);
  if (state.ledger_table_exists) {
    for (const [name, dataType] of expectedColumns) {
      if (
        !state.ledger_columns.some(
          (column) => column.name === name && column.data_type === dataType,
        )
      ) {
        throw new MigrationTargetError(
          "The existing Drizzle ledger has an unsupported or malformed schema",
        );
      }
    }
  }
}
