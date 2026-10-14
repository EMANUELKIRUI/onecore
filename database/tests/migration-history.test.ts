import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertMigrationHistorySafe,
  readMigrationFiles,
  validateMigrationHistory,
  type MigrationFile,
  type MigrationLedgerRow,
} from "../scripts/migration-history.js";

describe("migration history validation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "onecore-migration-history-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function addMigration(name: string, sql = "SELECT 1;"): Promise<void> {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "migration.sql"), sql);
  }

  it("reads valid Drizzle migration SQL and hashes its exact contents", async () => {
    await addMigration("20261001000000_first", "SELECT 1;");
    await addMigration("20261002000000_second", "SELECT 2;");

    const migrations = await readMigrationFiles(root);

    expect(migrations).toHaveLength(2);
    expect(migrations[0]).toMatchObject({
      name: "20261001000000_first",
      timestamp: Date.UTC(2026, 9, 1),
    });
    expect(migrations[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["malformed name", "bad_name", "Invalid migration directory name"],
    [
      "invalid calendar timestamp",
      "20260230000000_bad_date",
      "Invalid migration timestamp",
    ],
  ])("rejects %s", async (_label, name, error) => {
    await addMigration(name);
    await expect(readMigrationFiles(root)).rejects.toThrow(error);
  });

  it("rejects duplicate timestamps and duplicate SQL files", async () => {
    await addMigration("20261001000000_first");
    await addMigration("20261001000000_second");
    await expect(readMigrationFiles(root)).rejects.toThrow(
      "Duplicate migration timestamp",
    );

    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, "20261001000000_first"), { recursive: true });
    await writeFile(
      join(root, "20261001000000_first", "migration.sql"),
      "SELECT 1;",
    );
    await writeFile(
      join(root, "20261001000000_first", "extra.sql"),
      "SELECT 2;",
    );
    await expect(readMigrationFiles(root)).rejects.toThrow(
      "exactly one migration.sql",
    );
  });

  it("rejects missing, empty, or unsupported legacy migration metadata", async () => {
    await mkdir(join(root, "20261001000000_first"), { recursive: true });
    await expect(readMigrationFiles(root)).rejects.toThrow(
      "exactly one migration.sql",
    );

    await writeFile(
      join(root, "20261001000000_first", "migration.sql"),
      "  \n",
    );
    await expect(readMigrationFiles(root)).rejects.toThrow("empty");

    await mkdir(join(root, "meta"), { recursive: true });
    await writeFile(join(root, "meta", "_journal.json"), "{}");
    await expect(readMigrationFiles(root)).rejects.toThrow(
      "Legacy Drizzle migration journals are unsupported",
    );
  });

  it("rejects application objects without a usable migration ledger", () => {
    const migrations = [] as MigrationFile[];
    const result = validateMigrationHistory(migrations, null, 2);

    expect(result.integrity).toBe("unverifiable");
    expect(result.issues[0]).toContain("Application objects exist");
    expect(() => assertMigrationHistorySafe(result)).toThrow(
      "history unverifiable",
    );
  });

  it("permits an uninitialized database only when no application objects exist", () => {
    const migrations = [
      {
        name: "20261001000000_first",
        timestamp: 1790812800000,
        hash: "a".repeat(64),
      },
    ];

    expect(validateMigrationHistory(migrations, null, 0)).toMatchObject({
      integrity: "uninitialized",
      pendingNames: ["20261001000000_first"],
      issues: [],
    });
    expect(validateMigrationHistory(migrations, [], 1).integrity).toBe(
      "unverifiable",
    );
  });

  it("detects unknown, duplicated, missing-earlier, and out-of-order ledger rows", () => {
    const migrations = [
      {
        name: "20261001000000_first",
        timestamp: 1790812800000,
        hash: "a".repeat(64),
      },
      {
        name: "20261002000000_second",
        timestamp: 1790899200000,
        hash: "b".repeat(64),
      },
    ];
    const row = (id: number, migration: MigrationFile): MigrationLedgerRow => ({
      id,
      hash: migration.hash,
      created_at: migration.timestamp,
      name: migration.name,
    });

    const laterOnly = validateMigrationHistory(
      migrations,
      [row(1, migrations[1]!)],
      2,
    );
    expect(laterOnly.integrity).toBe("mismatch");
    expect(laterOnly.issues.join(" ")).toContain("later migration");

    const duplicate = validateMigrationHistory(
      migrations,
      [row(1, migrations[0]!), row(2, migrations[0]!)],
      2,
    );
    expect(duplicate.issues.join(" ")).toContain("duplicate record");

    const unknown = validateMigrationHistory(
      migrations,
      [
        {
          id: 1,
          hash: "c".repeat(64),
          created_at: 1,
          name: "unknown_migration",
        },
      ],
      2,
    );
    expect(unknown.issues.join(" ")).toContain("unknown migration");

    const outOfOrder = validateMigrationHistory(
      migrations,
      [row(1, migrations[1]!), row(2, migrations[0]!)],
      2,
    );
    expect(outOfOrder.issues.join(" ")).toContain(
      "records migrations out of timestamp order",
    );
  });

  it("blocks a ledger entry whose applied migration file was removed", async () => {
    await addMigration("20261001000000_first", "SELECT 1;");
    await addMigration("20261002000000_second", "SELECT 2;");
    const migrations = await readMigrationFiles(root);
    await rm(join(root, "20261001000000_first"), {
      recursive: true,
      force: true,
    });
    const currentFiles = await readMigrationFiles(root);

    const result = validateMigrationHistory(
      currentFiles,
      [
        {
          id: 1,
          hash: migrations[0]!.hash,
          created_at: migrations[0]!.timestamp,
          name: migrations[0]!.name,
        },
      ],
      2,
    );

    expect(result.integrity).toBe("mismatch");
    expect(result.issues.join(" ")).toContain(
      "unknown migration: 20261001000000_first",
    );
  });

  it("detects genuine checksum and timestamp mismatches", () => {
    const migration: MigrationFile = {
      name: "20261001000000_first",
      timestamp: 1790812800000,
      hash: "a".repeat(64),
    };
    const result = validateMigrationHistory(
      [migration],
      [
        {
          id: 1,
          hash: "b".repeat(64),
          created_at: migration.timestamp + 1,
          name: migration.name,
        },
      ],
      1,
    );

    expect(result.integrity).toBe("mismatch");
    expect(result.issues.join(" ")).toContain("contents differ");
    expect(result.issues.join(" ")).toContain("timestamp does not match");
  });

  it("marks incomplete historical checksums unverifiable instead of calling them changed", () => {
    const migration: MigrationFile = {
      name: "20261001000000_first",
      timestamp: 1790812800000,
      hash: "a".repeat(64),
    };
    const result = validateMigrationHistory(
      [migration],
      [
        {
          id: 1,
          hash: null,
          created_at: migration.timestamp,
          name: migration.name,
        },
      ],
      1,
    );

    expect(result.integrity).toBe("unverifiable");
    expect(result.issues.join(" ")).toContain("checksum is unavailable");
    expect(result.issues.join(" ")).not.toContain("contents differ");
  });

  it("accepts a verified prefix and reports remaining migrations as pending", () => {
    const migrations = [
      {
        name: "20261001000000_first",
        timestamp: 1790812800000,
        hash: "a".repeat(64),
      },
      {
        name: "20261002000000_second",
        timestamp: 1790899200000,
        hash: "b".repeat(64),
      },
    ];
    const result = validateMigrationHistory(
      migrations,
      [
        {
          id: 1,
          hash: migrations[0]!.hash,
          created_at: migrations[0]!.timestamp,
          name: migrations[0]!.name,
        },
      ],
      1,
    );

    expect(result).toMatchObject({
      integrity: "verified",
      pendingNames: ["20261002000000_second"],
      issues: [],
    });
  });

  it("rejects a ledger id duplicated independently of migration names", () => {
    const migration: MigrationFile = {
      name: "20261001000000_first",
      timestamp: 1790812800000,
      hash: "a".repeat(64),
    };
    const entry: MigrationLedgerRow = {
      id: 1,
      hash: migration.hash,
      created_at: migration.timestamp,
      name: migration.name,
    };
    const result = validateMigrationHistory(
      [migration],
      [entry, { ...entry, name: "20261002000000_second" }],
      1,
    );

    expect(result.integrity).toBe("mismatch");
    expect(result.issues.join(" ")).toContain("duplicate id");
  });
});
