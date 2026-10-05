import { createLogger, type RuntimeConfig } from "@onecore/config";
import Fastify from "fastify";

export function createApiFastify(config: RuntimeConfig) {
  return Fastify({
    loggerInstance: createLogger("onecore-api", config.LOG_LEVEL),
  });
}

export type ApiFastifyInstance = ReturnType<typeof createApiFastify>;
