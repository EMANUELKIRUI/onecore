import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import { sanitizeErrorForLog } from "@onecore/config";
import {
  LifecycleMutationError,
  type AuthorizationContext,
  type AuthorizationService,
  type LifecycleMutationService,
  type RateLimitDecision,
  type RateLimiter,
} from "@onecore/database";
import { z } from "zod";
import type { RuntimeConfig } from "@onecore/config";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import {
  requireAuthenticated,
  validateMutationOrigin,
} from "./authentication.js";

const passwordOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

const organizationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    industry: z.string().trim().min(1).max(100),
    deploymentType: z.enum(["SAAS", "CUSTOM", "DEDICATED", "ENTERPRISE"]),
    bootstrapOwner: z
      .object({
        email: z.email().trim().toLowerCase().max(320),
        displayName: z.string().trim().min(1).max(200).optional(),
        password: z.string().min(16).max(1_024).optional(),
      })
      .strict(),
  })
  .strict();
const userInputSchema = z
  .object({
    email: z.email().trim().toLowerCase().max(320),
    displayName: z.string().trim().min(1).max(200),
    password: z.string().min(16).max(1_024),
  })
  .strict();
const invitationInputSchema = z
  .object({
    email: z.email().trim().toLowerCase().max(320),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();
const organizationPathSchema = z.object({ organizationId: z.uuid() });
const organizationApplicationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    industry: z.string().trim().min(1).max(100),
    deploymentType: z.literal("SAAS"),
    contactEmail: z.email().trim().toLowerCase().max(320),
    contactPhone: z.string().trim().min(1).max(50),
    website: z.url().max(2_048).optional(),
    ownerName: z.string().trim().min(1).max(200),
    ownerEmail: z.email().trim().toLowerCase().max(320),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/),
    region: z.string().trim().min(1).max(100),
    city: z.string().trim().min(1).max(100),
    address: z.string().trim().min(1).max(300),
    requestedModules: z.array(z.string().trim().min(1).max(100)).max(50),
  })
  .strict();
const applicationTransitionSchema = z
  .object({ status: z.enum(["UNDER_REVIEW", "APPROVED", "REJECTED"]) })
  .strict();
const applicationProfileSchema = z.object({
  application: organizationApplicationSchema
    .omit({
      name: true,
      slug: true,
      industry: true,
      deploymentType: true,
    })
    .strict(),
});

const userCreatePermission = "core.organization.user.create";
const APPLICATION_RATE_LIMIT_MAX = 5;
const APPLICATION_RATE_LIMIT_WINDOW_MS = 60_000;

function requestContext(request: {
  auth: {
    userId: string;
    sessionId: string;
    organizationId: string | null;
    membershipId: string | null;
    branchId: string | null;
  } | null;
}): AuthorizationContext | null {
  const authenticated = request.auth;
  if (!authenticated) return null;
  return {
    userId: authenticated.userId,
    sessionId: authenticated.sessionId,
    organizationId: authenticated.organizationId,
    membershipId: authenticated.membershipId,
    branchId: authenticated.branchId,
  };
}

function sendError(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  statusCode: number,
  code: string,
  message: string,
) {
  return reply.status(statusCode).send({ error: { code, message } });
}

function sendLifecycleFailure(
  reply: Parameters<typeof sendError>[0],
  error: unknown,
) {
  if (!(error instanceof LifecycleMutationError)) throw error;
  const statusCode =
    error.code === "LIFECYCLE_UNAUTHORIZED"
      ? 403
      : error.code === "ORGANIZATION_NOT_FOUND"
        ? 404
        : error.code === "BOOTSTRAP_OWNER_CREDENTIALS_REQUIRED"
          ? 400
          : 409;
  const code =
    statusCode === 403
      ? "FORBIDDEN"
      : statusCode === 404
        ? "NOT_FOUND"
        : statusCode === 400
          ? "BAD_REQUEST"
          : "CONFLICT";
  const message =
    statusCode === 403
      ? "The request is not authorized."
      : statusCode === 404
        ? "The requested resource was not found."
        : statusCode === 400
          ? "A display name and password are required for a new bootstrap owner."
          : error.code === "APPLICATION_ALREADY_EXISTS"
            ? "An application using these details already exists."
            : "The requested lifecycle change conflicts with the current state.";
  return sendError(reply, statusCode, code, message);
}

function lifecycleMetadata(request: {
  id: string;
  observabilityContext: { correlationId: string } | null;
}) {
  return {
    requestId: request.id,
    correlationId: request.observabilityContext?.correlationId ?? request.id,
  };
}

export function registerLifecycleRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService,
  lifecycle: LifecycleMutationService,
  config: RuntimeConfig,
  rateLimiter?: RateLimiter,
): void {
  let applicationRateLimit: ReturnType<typeof app.rateLimit> | undefined;
  app.get(
    "/public/organization-applications/modules",
    async (_request, reply) => {
      const catalog = await lifecycle.listPublicModules();
      return reply.send({ modules: catalog });
    },
  );

  app.post(
    "/public/organization-applications",
    {
      preHandler: async (request, reply) => {
        if (rateLimiter) {
          let decision: RateLimitDecision;
          try {
            decision = await rateLimiter.consume({
              scope: "organization.application.submit",
              subject: request.ip,
              requestId: request.id,
              correlationId:
                request.observabilityContext?.correlationId ?? request.id,
              limit: APPLICATION_RATE_LIMIT_MAX,
              windowMs: APPLICATION_RATE_LIMIT_WINDOW_MS,
            });
          } catch (error) {
            request.log.error(
              {
                ...request.observabilityContext,
                eventType: "rate_limit_unavailable",
                scope: "organization.application.submit",
                err: sanitizeErrorForLog(error),
              },
              "Organization application rate limiter is unavailable",
            );
            return reply.status(503).send({
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "The service is temporarily unavailable.",
              },
            });
          }
          if (!decision.allowed) {
            request.log.warn(
              {
                ...request.observabilityContext,
                eventType: "rate_limit_triggered",
                scope: "organization.application.submit",
                resetAt: decision.resetAt.toISOString(),
              },
              "Organization application rate limit exceeded",
            );
            reply.header(
              "retry-after",
              Math.max(
                1,
                Math.ceil((decision.resetAt.getTime() - Date.now()) / 1_000),
              ),
            );
            return reply.status(429).send({
              error: {
                code: "TOO_MANY_REQUESTS",
                message: "Too many requests. Try again later.",
              },
            });
          }
        } else if (config.NODE_ENV === "production") {
          request.log.error(
            {
              ...request.observabilityContext,
              eventType: "rate_limit_unavailable",
              scope: "organization.application.submit",
            },
            "Shared organization application rate limiter is not configured",
          );
          return reply.status(503).send({
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "The service is temporarily unavailable.",
            },
          });
        } else {
          const limiter = (applicationRateLimit ??= app.rateLimit({
            max: APPLICATION_RATE_LIMIT_MAX,
            timeWindow: APPLICATION_RATE_LIMIT_WINDOW_MS,
          }));
          await limiter.call(app, request, reply);
          if (reply.sent) return reply;
        }
      },
    },
    async (request, reply) => {
      if (!validateMutationOrigin(request, reply, config)) return reply;
      const body = organizationApplicationSchema.safeParse(request.body);
      if (!body.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid organization application details.",
        );
      }
      try {
        const result = await lifecycle.submitOrganizationApplication(
          body.data,
          lifecycleMetadata(request),
        );
        return reply.status(201).send({
          application: {
            reference: result.organization.slug,
            organizationName: result.organization.name,
            status: result.organization.status,
            submittedAt: result.organization.createdAt.toISOString(),
          },
        });
      } catch (error) {
        if (
          error instanceof TypeError &&
          error.message === "APPLICATION_MODULE_UNAVAILABLE"
        ) {
          return sendError(
            reply,
            400,
            "BAD_REQUEST",
            "One or more requested modules are unavailable.",
          );
        }
        return sendLifecycleFailure(reply, error);
      }
    },
  );

  app.get(
    "/platform/organization-applications",
    { preHandler: requireAuthenticated() },
    async (request, reply) => {
      if (!request.auth) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      try {
        const applications = await lifecycle.listOrganizationApplications(
          request.auth,
        );
        return reply.send({
          applications: applications.map((organization) => {
            const profile = applicationProfileSchema.parse(
              organization.profile,
            );
            return {
              reference: organization.id,
              organization: {
                name: organization.name,
                slug: organization.slug,
                industry: organization.industry,
                deploymentType: organization.deploymentType,
              },
              applicant: profile.application,
              status: organization.status,
              submittedAt: organization.createdAt.toISOString(),
              updatedAt: organization.updatedAt.toISOString(),
            };
          }),
        });
      } catch (error) {
        return sendLifecycleFailure(reply, error);
      }
    },
  );

  app.post(
    "/platform/organization-applications/:organizationId/status",
    { preHandler: requireAuthenticated() },
    async (request, reply) => {
      if (!validateMutationOrigin(request, reply, config)) return reply;
      const path = organizationPathSchema.safeParse(request.params);
      const body = applicationTransitionSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid organization application transition.",
        );
      }
      if (!request.auth) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      try {
        const organization = await lifecycle.transitionOrganizationApplication(
          path.data.organizationId,
          body.data.status,
          request.auth,
          lifecycleMetadata(request),
        );
        return reply.send({
          application: {
            reference: organization.id,
            organizationName: organization.name,
            status: organization.status,
          },
        });
      } catch (error) {
        return sendLifecycleFailure(reply, error);
      }
    },
  );

  app.post(
    "/platform/organizations",
    {
      preHandler: requireAuthenticated(),
    },
    async (request, reply) => {
      if (!validateMutationOrigin(request, reply, config)) return reply;
      const body = organizationInputSchema.safeParse(request.body);
      if (!body.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid organization details.",
        );
      }
      if (!request.auth) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      try {
        const bootstrapOwner = {
          email: body.data.bootstrapOwner.email,
          ...(body.data.bootstrapOwner.displayName
            ? { displayName: body.data.bootstrapOwner.displayName }
            : {}),
          ...(body.data.bootstrapOwner.password
            ? {
                passwordHash: await hashPassword(
                  body.data.bootstrapOwner.password,
                  passwordOptions,
                ),
              }
            : {}),
        };
        const result = await lifecycle.createOrganization(
          { ...body.data, bootstrapOwner },
          request.auth,
          lifecycleMetadata(request),
        );
        return reply.status(201).send({
          organization: {
            id: result.organization.id,
            name: result.organization.name,
            slug: result.organization.slug,
            industry: result.organization.industry,
            status: result.organization.status,
            deploymentType: result.organization.deploymentType,
          },
          bootstrapOwner: {
            userId: result.bootstrapOwner.id,
            membershipId: result.bootstrapOwner.membershipId,
            email: result.bootstrapOwner.email,
            displayName: result.bootstrapOwner.displayName,
            status: "ACTIVE",
            role: "Organization Owner",
          },
        });
      } catch (error) {
        return sendLifecycleFailure(reply, error);
      }
    },
  );

  app.post(
    "/platform/organizations/:organizationId/activate",
    { preHandler: requireAuthenticated() },
    async (request, reply) => {
      if (!validateMutationOrigin(request, reply, config)) return reply;
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) {
        return sendError(
          reply,
          404,
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      }
      if (!request.auth) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      try {
        const organization = await lifecycle.activateOrganization(
          path.data.organizationId,
          request.auth,
          lifecycleMetadata(request),
        );
        return reply.status(200).send({
          organization: { id: organization.id, status: organization.status },
        });
      } catch (error) {
        return sendLifecycleFailure(reply, error);
      }
    },
  );

  app.post(
    "/organizations/:organizationId/users",
    { preHandler: requireAuthenticated() },
    async (request, reply) => {
      if (!validateMutationOrigin(request, reply, config)) return reply;
      const path = organizationPathSchema.safeParse(request.params);
      const body = userInputSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return sendError(reply, 400, "BAD_REQUEST", "Invalid user details.");
      }
      const metadata = lifecycleMetadata(request);
      try {
        const result = await authorization.withPermission(
          requestContext(request),
          userCreatePermission,
          { requestId: request.id },
          async (transaction, context) => {
            if (context.organizationId !== path.data.organizationId)
              return null;
            const passwordHash = await hashPassword(
              body.data.password,
              passwordOptions,
            );
            return lifecycle.createUser(
              transaction,
              context.organizationId,
              context.userId,
              metadata,
              {
                email: body.data.email,
                displayName: body.data.displayName,
                passwordHash,
              },
            );
          },
        );
        if (!result.allowed) {
          return sendError(
            reply,
            result.statusCode,
            result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            result.statusCode === 401
              ? "Authentication is required."
              : "The request is not authorized.",
          );
        }
        if (!result.value) {
          return sendError(
            reply,
            404,
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        }
        return reply.status(201).send({ user: result.value });
      } catch (error) {
        return sendLifecycleFailure(reply, error);
      }
    },
  );

  app.post(
    "/organizations/:organizationId/invitations",
    { preHandler: requireAuthenticated() },
    async (request, reply) => {
      if (!validateMutationOrigin(request, reply, config)) return reply;
      const path = organizationPathSchema.safeParse(request.params);
      const body = invitationInputSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid invitation details.",
        );
      }
      const metadata = lifecycleMetadata(request);
      try {
        const result = await authorization.withPermission(
          requestContext(request),
          userCreatePermission,
          { requestId: request.id },
          async (transaction, context) => {
            if (context.organizationId !== path.data.organizationId)
              return null;
            return lifecycle.inviteUser(
              transaction,
              context.organizationId,
              context.userId,
              metadata,
              body.data,
            );
          },
        );
        if (!result.allowed) {
          return sendError(
            reply,
            result.statusCode,
            result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            result.statusCode === 401
              ? "Authentication is required."
              : "The request is not authorized.",
          );
        }
        if (!result.value) {
          return sendError(
            reply,
            404,
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        }
        return reply.status(201).send({
          invitation: {
            userId: result.value.id,
            membershipId: result.value.membershipId,
            email: result.value.email,
            displayName: result.value.displayName,
            status: "INVITED",
            delivery: "NOT_CONFIGURED",
          },
        });
      } catch (error) {
        return sendLifecycleFailure(reply, error);
      }
    },
  );
}
