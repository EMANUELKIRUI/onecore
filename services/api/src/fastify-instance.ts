import {
  createLogger,
  resolveRequestId,
  type RuntimeConfig,
} from "@onecore/config";
import Fastify from "fastify";

export function createApiFastify(config: RuntimeConfig) {
  return Fastify({
    bodyLimit: 1_048_576,
    loggerInstance: createLogger(
      "onecore-api",
      config.LOG_LEVEL,
      undefined,
      config.NODE_ENV,
    ),
    requestIdHeader: false,
    genReqId: (request) => resolveRequestId(request.headers["x-request-id"]),
    trustProxy: false,
  });
}

export type ApiFastifyInstance = ReturnType<typeof createApiFastify>;
