import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger, sanitizeErrorForLog } from "@onecore/config";
import {
  checkDatabaseConnectivity,
  createAuthorizationService,
  createDatabase,
  createJobHandlerRegistry,
  createJobService,
  createWorkflowJobHandler,
} from "@onecore/database";
import { loadWorkerConfig } from "./config.js";
import { runWorker } from "./runner.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createLogger("onecore-worker", config.logLevel);
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { db, close, closeWithTimeout } = createDatabase(config.databaseUrl, {
    maxConnections: config.concurrency * 2 + 2,
  });
  let databaseClosed = false;
  const closeDatabase = async () => {
    if (databaseClosed) return;
    databaseClosed = true;
    await close();
  };
  const authorization = createAuthorizationService(db);
  const jobs = createJobService(
    db,
    authorization,
    createJobHandlerRegistry([createWorkflowJobHandler(db, authorization)]),
  );
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    logger.info({ signal, workerId }, "worker.shutdown.requested");
    controller.abort();
  };
  const onSigterm = () => stop("SIGTERM");
  const onSigint = () => stop("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    await checkDatabaseConnectivity(db);
    await jobs.listWorkerOrganizations();
    logger.info(
      {
        workerId,
        concurrency: config.concurrency,
        pollIntervalMilliseconds: config.pollIntervalMilliseconds,
      },
      "worker.ready",
    );
    const runtime = runWorker(
      jobs,
      {
        pollIntervalMilliseconds: config.pollIntervalMilliseconds,
        concurrency: config.concurrency,
      },
      logger,
      controller.signal,
      workerId,
    );
    let graceTimer: NodeJS.Timeout | undefined;
    let onShutdownRequested: (() => void) | undefined;
    const graceExceeded = new Promise<void>((resolve) => {
      onShutdownRequested = () => {
        graceTimer = setTimeout(() => {
          logger.warn(
            { shutdownGraceMilliseconds: config.shutdownGraceMilliseconds },
            "worker.shutdown.grace_exceeded",
          );
          resolve();
        }, config.shutdownGraceMilliseconds);
      };
      controller.signal.addEventListener("abort", onShutdownRequested, {
        once: true,
      });
    });
    const shutdownResult = await Promise.race([
      runtime.then(() => "stopped" as const),
      graceExceeded.then(() => "timed-out" as const),
    ]);
    if (onShutdownRequested) {
      controller.signal.removeEventListener("abort", onShutdownRequested);
    }
    if (graceTimer) clearTimeout(graceTimer);
    if (shutdownResult === "timed-out") {
      databaseClosed = true;
      await closeWithTimeout(1);
    }
    await runtime;
    logger.info({ workerId }, "worker.shutdown.completed");
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    await closeDatabase();
  }
}

try {
  await main();
} catch (error) {
  const logger = createLogger(
    "onecore-worker",
    process.env.LOG_LEVEL &&
      ["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(
        process.env.LOG_LEVEL,
      )
      ? process.env.LOG_LEVEL
      : "info",
  );
  logger.fatal({ err: sanitizeErrorForLog(error) }, "worker.startup.failed");
  process.exitCode = 1;
}
