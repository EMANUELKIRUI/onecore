import { createLogger, loadConfig, sanitizeErrorForLog } from "@onecore/config";
import {
  checkDatabaseConnectivity,
  createAuthorizationService,
  createDatabaseRateLimiter,
  createDatabase,
  createIdentityRepository,
  createLifecycleMutationService,
} from "@onecore/database";
import { buildApp } from "./app.js";

async function startApi(): Promise<void> {
  const configuredLogLevel = process.env.LOG_LEVEL;
  const logLevel =
    configuredLogLevel &&
    ["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(
      configuredLogLevel,
    )
      ? configuredLogLevel
      : "info";
  const logger = createLogger("onecore-api", logLevel);
  let app: ReturnType<typeof buildApp> | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;

  try {
    const config = loadConfig();
    if (!config.DATABASE_URL) {
      throw new Error("DATABASE_URL is required to start the API");
    }
    const { db, close } = createDatabase(config.DATABASE_URL);
    closeDatabase = close;
    app = buildApp(
      config,
      createIdentityRepository(db),
      createAuthorizationService(db),
      {
        readinessCheck: () => checkDatabaseConnectivity(db),
        rateLimiter: createDatabaseRateLimiter(db),
        lifecycleMutations: createLifecycleMutationService(db),
        database: db,
      },
    );
    app.addHook("onClose", close);

    const shutdown = (signal: NodeJS.Signals) => {
      app?.log.info({ signal }, "API shutdown requested");
      void app?.close().catch((error: unknown) => {
        app?.log.error(
          { err: sanitizeErrorForLog(error) },
          "API server failed to shut down cleanly",
        );
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));

    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    if (app) {
      await app.close().catch((closeError: unknown) => {
        logger.error(
          { err: sanitizeErrorForLog(closeError) },
          "API server failed to close after startup failure",
        );
      });
    } else if (closeDatabase) {
      await closeDatabase().catch((closeError: unknown) => {
        logger.error(
          { err: sanitizeErrorForLog(closeError) },
          "API database pool failed to close after startup failure",
        );
      });
    }
    logger.fatal({ err: sanitizeErrorForLog(error) }, "API startup failed");
    process.exitCode = 1;
  }
}

await startApi();
