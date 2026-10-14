import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const migrationDirectoryPattern = /^(\d{14})_([a-z0-9][a-z0-9_-]*)$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface MigrationFile {
  name: string;
  timestamp: number;
  hash: string;
}

export interface MigrationLedgerRow {
  id: number | string;
  hash: string | null;
  created_at: number | string | null;
  name: string | null;
}

export interface MigrationHistoryResult {
  integrity: "verified" | "unverifiable" | "mismatch" | "uninitialized";
  pendingNames: string[];
  issues: string[];
}

export class MigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationHistoryError";
  }
}

function timestampFromName(name: string): number {
  const match = migrationDirectoryPattern.exec(name);
  if (!match) {
    throw new MigrationHistoryError(
      `Invalid migration directory name: ${name}`,
    );
  }

  const value = match[1];
  if (!value) {
    throw new MigrationHistoryError(
      `Invalid migration timestamp in directory: ${name}`,
    );
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new MigrationHistoryError(
      `Invalid migration timestamp in directory: ${name}`,
    );
  }

  return date.getTime();
}

export async function readMigrationFiles(
  migrationsFolder: string,
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsFolder, { withFileTypes: true });
  if (entries.some((entry) => entry.name === "meta" && entry.isDirectory())) {
    const legacyJournal = join(migrationsFolder, "meta", "_journal.json");
    try {
      await stat(legacyJournal);
      throw new MigrationHistoryError(
        "Legacy Drizzle migration journals are unsupported by the installed migrator",
      );
    } catch (error) {
      if (error instanceof MigrationHistoryError) throw error;
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }

  const migrationEntries = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const migrations: MigrationFile[] = [];
  const timestamps = new Set<number>();

  for (const entry of migrationEntries) {
    const timestamp = timestampFromName(entry.name);
    if (timestamps.has(timestamp)) {
      throw new MigrationHistoryError(
        `Duplicate migration timestamp: ${entry.name.slice(0, 14)}`,
      );
    }
    timestamps.add(timestamp);

    const directory = join(migrationsFolder, entry.name);
    const files = await readdir(directory, { withFileTypes: true });
    const sqlFiles = files.filter(
      (file) => file.isFile() && file.name.endsWith(".sql"),
    );
    if (sqlFiles.length !== 1 || sqlFiles[0]?.name !== "migration.sql") {
      throw new MigrationHistoryError(
        `Migration ${entry.name} must contain exactly one migration.sql file`,
      );
    }

    const contents = await readFile(join(directory, "migration.sql"), "utf8");
    if (contents.trim().length === 0) {
      throw new MigrationHistoryError(
        `Migration ${entry.name} has an empty migration.sql file`,
      );
    }
    migrations.push({
      name: entry.name,
      timestamp,
      hash: createHash("sha256").update(contents).digest("hex"),
    });
  }

  if (migrations.length === 0) {
    throw new MigrationHistoryError("No migration directories were found");
  }

  return migrations;
}

function safeInteger(value: number | string | null): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function validateMigrationHistory(
  migrations: MigrationFile[],
  ledger: MigrationLedgerRow[] | null,
  applicationObjectCount: number,
): MigrationHistoryResult {
  if (ledger === null || ledger.length === 0) {
    if (applicationObjectCount > 0) {
      return {
        integrity: "unverifiable",
        pendingNames: [],
        issues: [
          "Application objects exist but the Drizzle migration ledger has no records; reconcile the database and history manually",
        ],
      };
    }
    return {
      integrity: "uninitialized",
      pendingNames: migrations.map((migration) => migration.name),
      issues: [],
    };
  }

  const issues: string[] = [];
  const migrationByName = new Map(
    migrations.map((migration, index) => [
      migration.name,
      { migration, index },
    ]),
  );
  const seenIds = new Set<number>();
  const seenNames = new Set<string>();
  const appliedIndexes: number[] = [];
  let integrity: MigrationHistoryResult["integrity"] = "verified";

  for (const row of ledger) {
    const id = safeInteger(row.id);
    if (id === undefined || seenIds.has(id)) {
      issues.push("The migration ledger contains an invalid or duplicate id");
      integrity = "mismatch";
      continue;
    }
    seenIds.add(id);

    if (row.name === null || row.name.length === 0) {
      issues.push(
        "A ledger record has no migration name; its history is unverifiable",
      );
      if (integrity !== "mismatch") integrity = "unverifiable";
      continue;
    }
    if (seenNames.has(row.name)) {
      issues.push(
        `The migration ledger contains a duplicate record: ${row.name}`,
      );
      integrity = "mismatch";
      continue;
    }
    seenNames.add(row.name);

    const local = migrationByName.get(row.name);
    if (!local) {
      issues.push(
        `The migration ledger refers to an unknown migration: ${row.name}`,
      );
      integrity = "mismatch";
      continue;
    }
    appliedIndexes.push(local.index);

    const storedTimestamp = safeInteger(row.created_at);
    if (storedTimestamp === undefined) {
      issues.push(`The ledger timestamp is unverifiable for ${row.name}`);
      if (integrity !== "mismatch") integrity = "unverifiable";
    } else if (storedTimestamp !== local.migration.timestamp) {
      issues.push(`The ledger timestamp does not match ${row.name}`);
      integrity = "mismatch";
    }

    if (row.hash === null || !sha256Pattern.test(row.hash)) {
      issues.push(
        `The ledger checksum is unavailable or malformed for ${row.name}`,
      );
      if (integrity !== "mismatch") integrity = "unverifiable";
    } else if (row.hash !== local.migration.hash) {
      issues.push(
        `The migration contents differ from the recorded checksum for ${row.name}`,
      );
      integrity = "mismatch";
    }
  }

  const sortedIndexes = [...appliedIndexes].sort((left, right) => left - right);
  if (
    appliedIndexes.some(
      (migrationIndex, index) => migrationIndex !== sortedIndexes[index],
    )
  ) {
    issues.push(
      "The migration ledger records migrations out of timestamp order",
    );
    integrity = "mismatch";
  }
  for (let index = 0; index < sortedIndexes.length; index += 1) {
    if (sortedIndexes[index] !== index) {
      issues.push(
        "Applied migrations are not a complete ordered prefix; a later migration is recorded while an earlier migration is absent",
      );
      integrity = "mismatch";
      break;
    }
  }

  if (issues.length > 0) {
    return { integrity, pendingNames: [], issues };
  }

  return {
    integrity,
    pendingNames: migrations
      .slice(sortedIndexes.length)
      .map(({ name }) => name),
    issues: [],
  };
}

export function assertMigrationHistorySafe(
  result: MigrationHistoryResult,
): void {
  if (result.issues.length > 0) {
    throw new MigrationHistoryError(
      `Migration history ${result.integrity}: ${result.issues.join("; ")}`,
    );
  }
}
