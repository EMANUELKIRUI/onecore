import { loadConfig } from "@onecore/config";
import { z } from "zod";

const workerEnvironmentSchema = z.object({
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(5_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
});

export interface WorkerConfig {
  databaseUrl: string;
  logLevel: string;
  pollIntervalMilliseconds: number;
  concurrency: number;
  shutdownGraceMilliseconds: number;
}

export class WorkerConfigurationError extends Error {
  constructor(readonly invalidKeys: readonly string[]) {
    super(`Invalid worker configuration: ${invalidKeys.join(", ")}`);
    this.name = "WorkerConfigurationError";
  }
}

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const runtime = loadConfig(environment);
  const parsed = workerEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    const invalidKeys = [
      ...new Set(
        parsed.error.issues.flatMap((issue) =>
          typeof issue.path[0] === "string" ? [issue.path[0]] : [],
        ),
      ),
    ];
    throw new WorkerConfigurationError(
      invalidKeys.length > 0 ? invalidKeys : ["worker environment"],
    );
  }
  if (!runtime.DATABASE_URL) {
    throw new WorkerConfigurationError(["DATABASE_URL"]);
  }
  return {
    databaseUrl: runtime.DATABASE_URL,
    logLevel: runtime.LOG_LEVEL,
    pollIntervalMilliseconds: parsed.data.WORKER_POLL_INTERVAL_MS,
    concurrency: parsed.data.WORKER_CONCURRENCY,
    shutdownGraceMilliseconds: parsed.data.WORKER_SHUTDOWN_GRACE_MS,
  };
}
