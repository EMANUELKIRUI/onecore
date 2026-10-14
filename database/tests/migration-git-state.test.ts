import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUncommittedMigrationNames } from "../scripts/migration-git-state.js";

describe("migration repository state", () => {
  let repositoryRoot: string;
  let migrationsFolder: string;

  beforeEach(async () => {
    repositoryRoot = await mkdtemp(join(tmpdir(), "onecore-migration-git-"));
    migrationsFolder = join(repositoryRoot, "database", "migrations");
    const trackedMigration = join(
      migrationsFolder,
      "20261001000000_existing",
      "migration.sql",
    );
    await mkdir(join(migrationsFolder, "20261001000000_existing"), {
      recursive: true,
    });
    await writeFile(trackedMigration, "SELECT 1;\n");

    execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.name", "Migration Test"], {
      cwd: repositoryRoot,
    });
    execFileSync(
      "git",
      ["config", "user.email", "migration-test@example.test"],
      {
        cwd: repositoryRoot,
      },
    );
    execFileSync("git", ["add", "database/migrations"], {
      cwd: repositoryRoot,
    });
    execFileSync("git", ["commit", "--quiet", "-m", "Initial fixture"], {
      cwd: repositoryRoot,
    });

    await writeFile(trackedMigration, "SELECT 2;\n");
    const untrackedDirectory = join(
      migrationsFolder,
      "20261002000000_untracked",
    );
    await mkdir(untrackedDirectory);
    await writeFile(join(untrackedDirectory, "migration.sql"), "SELECT 3;\n");
    await writeFile(
      join(migrationsFolder, "README.md"),
      "Migration guidance\n",
    );
  });

  afterEach(async () => {
    await rm(repositoryRoot, { recursive: true, force: true });
  });

  it("reports tracked modifications and untracked migration files", async () => {
    await expect(
      readUncommittedMigrationNames(migrationsFolder),
    ).resolves.toEqual(["20261001000000_existing", "20261002000000_untracked"]);
  });
});
