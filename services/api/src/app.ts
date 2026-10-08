import type { RuntimeConfig } from "@onecore/config";
import {
  denyAllAuthorizationService,
  type AuthorizationService,
  type IdentityRepository,
  type LifecycleMutationService,
  type RateLimiter,
} from "@onecore/database";
import type { ApiErrorResponse, HealthResponse } from "@onecore/contracts";
import type { SecretStore } from "@onecore/core-domain";
import {
  classifyError,
  getRequestContext,
  resolveCorrelationId,
  runWithRequestContext,
  sanitizeErrorForLog,
  type RequestContext,
} from "@onecore/config";
import { registerAuthentication } from "./authentication.js";
import { registerAuthorizationRoutes } from "./authorization.js";
import { registerConfigurationRoutes } from "./configuration.js";
import { registerConfigurationResourceRoutes } from "./configuration-resources.js";
import { registerCommunicationRoutes } from "./communications.js";
import { registerIntegrationSecurityRoutes } from "./integration-resources.js";
import { registerEventRoutes } from "./events.js";
import { registerWorkflowRoutes } from "./workflows.js";
import { registerModuleRoutes } from "./modules.js";
import { registerLifecycleRoutes } from "./lifecycle.js";
import { createApiFastify } from "./fastify-instance.js";
import { unavailableSecretStore } from "./integration-boundaries.js";

export interface ApiAppOptions {
  readinessCheck?: () => Promise<void>;
  rateLimiter?: RateLimiter;
  lifecycleMutations?: LifecycleMutationService;
  secretStore?: SecretStore;
}

declare module "fastify" {
  interface FastifyRequest {
    observabilityContext: RequestContext | null;
    requestStartedAt: number;
  }
}

function withRequestCorrelation(
  authorization: AuthorizationService,
): AuthorizationService {
  const metadataWithContext = (metadata: { requestId: string }) => {
    const correlationId = getRequestContext()?.correlationId;
    return correlationId ? { ...metadata, correlationId } : metadata;
  };

  return {
    authorize: (context, permissionKey, metadata) =>
      authorization.authorize(
        context,
        permissionKey,
        metadataWithContext(metadata),
      ),
    hasPermission: (context, permissionKey, metadata) =>
      authorization.hasPermission(
        context,
        permissionKey,
        metadataWithContext(metadata),
      ),
    withPermission: (context, permissionKey, metadata, operation) =>
      authorization.withPermission(
        context,
        permissionKey,
        metadataWithContext(metadata),
        operation,
      ),
    withAllPermissions: (context, permissionKeys, metadata, operation) =>
      authorization.withAllPermissions(
        context,
        permissionKeys,
        metadataWithContext(metadata),
        operation,
      ),
    withAnyPermission: (context, permissionKeys, metadata, operation) =>
      authorization.withAnyPermission(
        context,
        permissionKeys,
        metadataWithContext(metadata),
        operation,
      ),
  };
}

export function buildApp(
  config: RuntimeConfig,
  identityRepository: IdentityRepository,
  authorizationService: AuthorizationService = denyAllAuthorizationService,
  options: ApiAppOptions = {},
) {
  const app = createApiFastify(config);

  app.decorateRequest("observabilityContext", null);
  app.decorateRequest("requestStartedAt", 0);
  app.addHook("onRequest", (request, reply, done) => {
    const correlationId = resolveCorrelationId(
      request.headers["x-correlation-id"],
      request.id,
    );
    const context: RequestContext = {
      requestId: request.id,
      correlationId,
      userId: null,
      organizationId: null,
      branchId: null,
    };
    request.observabilityContext = context;
    request.requestStartedAt = performance.now();
    reply.header("x-request-id", context.requestId);
    reply.header("x-correlation-id", context.correlationId);
    runWithRequestContext(context, done);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=()",
    );
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (request.url.startsWith("/health")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
  app.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        ...request.observabilityContext,
        eventType: "http.request.completed",
        operation: request.routeOptions.url ?? "unmatched",
        method: request.method,
        durationMs: Math.max(
          0,
          Math.round(performance.now() - request.requestStartedAt),
        ),
        status: reply.statusCode,
      },
      "HTTP request completed",
    );
    done();
  });

  const correlatedAuthorization = withRequestCorrelation(authorizationService);
  registerAuthentication(app, config, identityRepository, options.rateLimiter);
  registerAuthorizationRoutes(app, correlatedAuthorization);
  registerConfigurationRoutes(app, correlatedAuthorization);
  registerConfigurationResourceRoutes(app, correlatedAuthorization);
  registerCommunicationRoutes(app, correlatedAuthorization);
  registerIntegrationSecurityRoutes(
    app,
    correlatedAuthorization,
    options.secretStore ?? unavailableSecretStore,
  );
  registerEventRoutes(app, correlatedAuthorization);
  registerWorkflowRoutes(app, correlatedAuthorization);
  registerModuleRoutes(app, correlatedAuthorization);
  if (options.lifecycleMutations) {
    registerLifecycleRoutes(
      app,
      correlatedAuthorization,
      options.lifecycleMutations,
      config,
    );
  }

  const live = async (): Promise<HealthResponse> => ({ status: "ok" });
  app.get<{ Reply: HealthResponse }>("/health", live);
  app.get<{ Reply: HealthResponse }>("/health/live", live);
  app.get("/health/ready", async (request, reply) => {
    try {
      if (!options.readinessCheck) {
        throw new Error("Readiness dependency check is not configured");
      }
      await options.readinessCheck();
      return reply.send({ status: "ready" });
    } catch (error) {
      request.log.error(
        {
          ...request.observabilityContext,
          errorCategory: classifyError(error),
          errorCode: classifyError(error),
          err: sanitizeErrorForLog(error),
        },
        "Readiness dependency check failed",
      );
      return reply.status(503).send({ status: "not_ready" });
    }
  });

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
    const category = classifyError(error);
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

    request.log.error(
      {
        ...request.observabilityContext,
        errorCategory: category,
        errorCode: category,
        err: sanitizeErrorForLog(error),
      },
      "Unhandled server error",
    );
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
