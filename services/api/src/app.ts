import type { RuntimeConfig } from "@onecore/config";
import {
  denyAllAuthorizationService,
  type AuthorizationService,
  type IdentityRepository,
} from "@onecore/database";
import type { ApiErrorResponse, HealthResponse } from "@onecore/contracts";
import { registerAuthentication } from "./authentication.js";
import { registerAuthorizationRoutes } from "./authorization.js";
import { registerModuleRoutes } from "./modules.js";
import { createApiFastify } from "./fastify-instance.js";

export function buildApp(
  config: RuntimeConfig,
  identityRepository: IdentityRepository,
  authorizationService: AuthorizationService = denyAllAuthorizationService,
) {
  const app = createApiFastify(config);

  registerAuthentication(app, config, identityRepository);
  registerAuthorizationRoutes(app, authorizationService);
  registerModuleRoutes(app, authorizationService);

  app.get<{ Reply: HealthResponse }>("/health", async () => ({ status: "ok" }));

  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorResponse = {
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const code =
        statusCode === 401
          ? "UNAUTHORIZED"
          : statusCode === 403
            ? "FORBIDDEN"
            : statusCode === 429
              ? "TOO_MANY_REQUESTS"
              : "BAD_REQUEST";
      const body: ApiErrorResponse = {
        error: {
          code,
          message:
            statusCode === 401
              ? "Authentication is required."
              : statusCode === 403
                ? "The request is not authorized."
                : statusCode === 429
                  ? "Too many requests. Try again later."
                  : "The request could not be processed.",
        },
      };
      return reply.status(statusCode).send(body);
    }

    request.log.error({ err: error }, "Unhandled server error");
    const body: ApiErrorResponse = {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    };
    return reply.status(500).send(body);
  });

  return app;
}
