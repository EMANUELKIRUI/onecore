import {
  assertMigrationHistorySafe,
  readMigrationFiles,
  validateMigrationHistory,
  type MigrationLedgerRow,
} from "./migration-history.js";
import {
  assertConnectedMigrationIdentity,
  assertMigrationDatabaseState,
  MigrationTargetError,
  resolveMigrationTarget,
} from "./migration-target.js";

export interface MigrationInspection {
  identity: unknown;
  databaseState: unknown;
  ledger: MigrationLedgerRow[] | null;
}

export interface MigrationConnection {
  inspect(): Promise<MigrationInspection>;
  close(): Promise<void>;
}

export interface MigrationRunnerDependencies {
  connect(connectionString: string): Promise<MigrationConnection>;
  migrate(
    connection: MigrationConnection,
    migrationsFolder: string,
  ): Promise<void>;
  readUncommittedMigrationNames(migrationsFolder: string): Promise<string[]>;
  log(message: string): void;
}

export interface MigrationRunOptions {
  environment: NodeJS.ProcessEnv;
  migrationsFolder: string;
  validateOnly: boolean;
}

export class MigrationExecutionError extends Error {
  constructor(cause: unknown) {
    super(
      "Migration execution failed. Drizzle may have created its metadata schema or table before the migration transaction; verify the target read-only before retrying and never repair the ledger manually.",
      { cause },
    );
    this.name = "MigrationExecutionError";
  }
}

function reviewedUncommittedNames(environment: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (environment.ONECORE_MIGRATION_REVIEWED_UNTRACKED ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function assertUncommittedMigrationsReviewed(
  migrationNames: string[],
  environment: NodeJS.ProcessEnv,
): void {
  if (migrationNames.length === 0) return;
  if (
    environment.ONECORE_MIGRATION_ENVIRONMENT === "production" ||
    environment.ONECORE_MIGRATION_ENVIRONMENT === "staging"
  ) {
    throw new MigrationTargetError(
      "Staging and production migrations must come from committed, clean migration files",
    );
  }

  const reviewed = reviewedUncommittedNames(environment);
  const notReviewed = migrationNames.filter((name) => !reviewed.has(name));
  if (notReviewed.length > 0) {
    throw new MigrationTargetError(
      `Uncommitted migrations require explicit review: ${notReviewed.join(", ")}`,
    );
  }
}

function assertEmptyDatabaseInitializationApproved(
  history: ReturnType<typeof validateMigrationHistory>,
  applicationObjectCount: number,
  environment: NodeJS.ProcessEnv,
  resourceId: string | undefined,
  database: string,
): void {
  if (history.integrity !== "uninitialized") return;
  if (applicationObjectCount !== 0) {
    throw new MigrationTargetError(
      "A missing migration ledger is safe to initialize only when no application objects exist",
    );
  }
  const migrationEnvironment = environment.ONECORE_MIGRATION_ENVIRONMENT;
  if (
    migrationEnvironment === "development" ||
    migrationEnvironment === "test"
  ) {
    return;
  }

  const approval = environment.ONECORE_MIGRATION_INITIALIZE_EMPTY_DATABASE;
  const expectedApproval = `${resourceId}/${database}`;
  if (!resourceId || approval !== expectedApproval) {
    throw new MigrationTargetError(
      "Empty staging/production databases require ONECORE_MIGRATION_INITIALIZE_EMPTY_DATABASE to match the verified resource ID and database",
    );
  }
}

export async function runMigration(
  options: MigrationRunOptions,
  dependencies: MigrationRunnerDependencies,
): Promise<void> {
  const target = resolveMigrationTarget(options.environment);
  const migrations = await readMigrationFiles(options.migrationsFolder);
  const uncommittedNames = await dependencies.readUncommittedMigrationNames(
    options.migrationsFolder,
  );
  assertUncommittedMigrationsReviewed(uncommittedNames, options.environment);

  const connection = await dependencies.connect(target.connectionString);
  try {
    const inspection = await connection.inspect();
    const identity = inspection.identity;
    const databaseState = inspection.databaseState;
    assertConnectedMigrationIdentity(identity, target);
    assertMigrationDatabaseState(databaseState, target);

    const history = validateMigrationHistory(
      migrations,
      inspection.ledger,
      databaseState.application_object_count,
    );
    assertMigrationHistorySafe(history);
    assertEmptyDatabaseInitializationApproved(
      history,
      databaseState.application_object_count,
      options.environment,
      target.resourceId,
      target.database,
    );

    if (options.validateOnly) {
      dependencies.log(
        `Migration validation passed (${history.integrity}); ${history.pendingNames.length} migration(s) pending. No migration SQL or ledger writes were executed.`,
      );
      return;
    }

    try {
      await dependencies.migrate(connection, options.migrationsFolder);
    } catch (error) {
      throw new MigrationExecutionError(error);
    }
    dependencies.log("Database migrations completed.");
  } finally {
    await connection.close();
  }
}
