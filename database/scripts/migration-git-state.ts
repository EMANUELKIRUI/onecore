import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve } from "node:path";
import { MigrationTargetError } from "./migration-target.js";

const executeFile = promisify(execFile);

export async function readUncommittedMigrationNames(
  directory: string,
): Promise<string[]> {
  const repositoryRoot = resolve(directory, "../..");
  const migrationDirectory = relative(repositoryRoot, directory);
  let stdout: string;
  try {
    ({ stdout } = await executeFile(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        migrationDirectory,
      ],
      { cwd: repositoryRoot, maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw new MigrationTargetError(
      "Unable to verify migration repository state; refusing to migrate",
    );
  }

  const names = stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? "")
    .filter((file) => file.startsWith(`${migrationDirectory}/`))
    .map((file) => file.slice(migrationDirectory.length + 1))
    .filter((path) => path.includes("/"))
    .map((path) => path.split("/")[0] ?? "")
    .filter((name) => /^\d{14}_[A-Za-z0-9_-]+$/.test(name))
    .filter(Boolean);
  return [...new Set(names)];
}
