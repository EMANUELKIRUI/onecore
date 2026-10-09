import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

export async function applyTestMigrations(
  client: PGlite,
  migrationsDirectory: string,
): Promise<void> {
  await client.exec(
    "CREATE ROLE onecore_worker NOLOGIN NOSUPERUSER NOBYPASSRLS",
  );
  const migrationDirectories = await readdir(migrationsDirectory, {
    withFileTypes: true,
  });
  const names = migrationDirectories
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const migration = await readFile(
      join(migrationsDirectory, name, "migration.sql"),
      "utf8",
    );
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    await client.exec("BEGIN");
    try {
      for (const statement of statements) {
        await client.exec(statement);
      }
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw error;
    }
  }
}
