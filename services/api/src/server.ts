import { loadConfig, sanitizeErrorForLog } from "@onecore/config";
import {
  checkDatabaseConnectivity,
  createAuthorizationService,
  createDatabaseRateLimiter,
  createDatabase,
  createIdentityRepository,
} from "@onecore/database";
import { buildApp } from "./app.js";

const config = loadConfig();
if (!config.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to start the API");
}
const { db, close } = createDatabase(config.DATABASE_URL);
const app = buildApp(
  config,
  createIdentityRepository(db),
  createAuthorizationService(db),
  {
    readinessCheck: () => checkDatabaseConnectivity(db),
    rateLimiter: createDatabaseRateLimiter(db),
  },
);
app.addHook("onClose", close);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(
    { err: sanitizeErrorForLog(error) },
    "API server failed to start",
  );
  await app.close();
  process.exitCode = 1;
}
