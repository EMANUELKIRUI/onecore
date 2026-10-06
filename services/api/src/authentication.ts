import { createHash, randomBytes } from "node:crypto";
import {
  Algorithm,
  hash as hashPassword,
  verify as verifyPassword,
} from "@node-rs/argon2";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { hashRateLimitIdentity, type RuntimeConfig } from "@onecore/config";
import type {
  AuthenticationAuditEvent,
  IdentityRepository,
  IdentityUser,
  RateLimiter,
} from "@onecore/database";
import type {
  FastifyReply,
  FastifyRequest,
  onSendAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";
import Fastify from "fastify";
import { z } from "zod";

const SESSION_COOKIE = "onecore_session";
const FAILURE_WINDOW_MS = 15 * 60_000;
const ACCOUNT_FAILURE_THRESHOLD = 10;
const ACCOUNT_LOCK_MS = 15 * 60_000;
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};
const sessionSecretSchema = /^[A-Za-z0-9_-]{43}$/;
const loginSchema = z.object({
  email: z
    .email()
    .max(320)
    .transform((email) => email.trim().toLowerCase()),
  password: z.string().min(1).max(1_024),
});
const organizationSelectionSchema = z.object({
  organizationId: z.uuid(),
});
const branchSelectionSchema = z.object({
  branchId: z.uuid(),
});

const dummyPasswordHash = hashPassword(randomBytes(32), ARGON2_OPTIONS);

export interface AuthenticatedRequestContext {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  organizationId: string | null;
  membershipId: string | null;
  branchId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthenticatedRequestContext | null;
  }
}

function sessionDigest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function requestMetadata(request: FastifyRequest) {
  return {
    requestId: request.id,
    correlationId: request.observabilityContext?.correlationId ?? request.id,
    ipAddress: request.ip.slice(0, 45),
    userAgent: (request.headers["user-agent"] ?? "").slice(0, 512),
  };
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST",
  message: string,
) {
  return reply.status(statusCode).send({ error: { code, message } });
}

function cookieOptions(config: RuntimeConfig) {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

function clearSessionCookie(reply: FastifyReply, config: RuntimeConfig) {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

export function validateMutationOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: RuntimeConfig,
): boolean {
  const contentType = request.headers["content-type"]?.split(";")[0];
  if (contentType !== "application/json") {
    sendError(reply, 400, "BAD_REQUEST", "A JSON request body is required.");
    return false;
  }

  if (request.headers["sec-fetch-site"] === "cross-site") {
    sendError(reply, 403, "FORBIDDEN", "The request origin is not allowed.");
    return false;
  }

  const origin = request.headers.origin;
  if (origin) {
    const sameOrigin = `${request.protocol}://${request.hostname}`;
    const allowedOrigins =
      config.AUTH_ALLOWED_ORIGINS.length > 0
        ? config.AUTH_ALLOWED_ORIGINS
        : [sameOrigin];
    if (!allowedOrigins.includes(origin)) {
      sendError(reply, 403, "FORBIDDEN", "The request origin is not allowed.");
      return false;
    }
  }

  return true;
}

function authenticationAudit(
  request: FastifyRequest,
  details: Omit<
    AuthenticationAuditEvent,
    "requestId" | "ipAddress" | "userAgent" | "occurredAt"
  >,
): AuthenticationAuditEvent {
  return {
    ...requestMetadata(request),
    ...details,
    occurredAt: new Date(),
  };
}

export function requireAuthenticated(): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (request.auth) return;
    return sendError(reply, 401, "UNAUTHORIZED", "Authentication is required.");
  };
}

export function requireOrganizationMembership(): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (
      request.auth?.organizationId &&
      request.auth.membershipId &&
      request.auth.sessionId
    ) {
      return;
    }
    return sendError(
      reply,
      403,
      "FORBIDDEN",
      "An active organization context is required.",
    );
  };
}

export function registerAuthentication(
  app: ReturnType<typeof Fastify>,
  config: RuntimeConfig,
  identity: IdentityRepository,
  rateLimiter?: RateLimiter,
): void {
  app.register(cookie);
  app.register(rateLimit, { global: false });
  app.decorateRequest("auth", null);
  let loginRateLimit: preHandlerAsyncHookHandler | undefined;

  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = request.cookies[SESSION_COOKIE];
      if (!secret) {
        request.auth = null;
        return;
      }
      if (!sessionSecretSchema.test(secret)) {
        request.log.warn(
          {
            ...request.observabilityContext,
            eventType: "session.invalid",
            reason: "malformed_cookie",
          },
          "Invalid session cookie rejected",
        );
        clearSessionCookie(reply, config);
        request.auth = null;
        return;
      }

      const secretHash = sessionDigest(secret);
      const resolved = await identity.findActiveSession(secretHash, new Date());
      if (!resolved) {
        request.log.info(
          {
            ...request.observabilityContext,
            eventType: "session.invalid",
            reason: "inactive_or_expired",
          },
          "Inactive session rejected",
        );
        clearSessionCookie(reply, config);
        request.auth = null;
        return;
      }

      let organizationId = resolved.session.organizationId;
      let membershipId: string | null = null;
      let branchId = resolved.session.branchId;
      if (organizationId) {
        const memberships = await identity.listActiveMemberships(
          resolved.user.id,
        );
        const membership = memberships.find(
          (candidate) => candidate.organizationId === organizationId,
        );
        if (!membership) {
          const staleOrganizationId = organizationId;
          organizationId = null;
          branchId = null;
          const metadata = requestMetadata(request);
          await identity.clearSessionOrganization(
            secretHash,
            staleOrganizationId,
            metadata.requestId,
            metadata.ipAddress,
            metadata.userAgent,
            new Date(),
          );
        } else {
          membershipId = membership.membershipId;
          if (branchId) {
            const authorizedBranches = await identity.listAuthorizedBranches(
              resolved.user.id,
              organizationId,
            );
            if (
              !authorizedBranches.some((branch) => branch.branchId === branchId)
            ) {
              const staleBranchId = branchId;
              branchId = null;
              const metadata = requestMetadata(request);
              await identity.clearSessionBranch(
                secretHash,
                staleBranchId,
                metadata.requestId,
                metadata.ipAddress,
                metadata.userAgent,
                new Date(),
              );
            }
          }
        }
      } else {
        branchId = null;
      }

      await identity.touchSession(secretHash, new Date());
      request.auth = {
        userId: resolved.user.id,
        sessionId: resolved.session.id,
        sessionExpiresAt: resolved.session.expiresAt,
        organizationId,
        membershipId,
        branchId,
      };
      if (request.observabilityContext) {
        Object.assign(request.observabilityContext, {
          userId: resolved.user.id,
          organizationId,
          branchId,
        });
      }
    },
  );
  const avoidAuthResponseCaching: onSendAsyncHookHandler = async (
    request,
    reply,
    payload,
  ) => {
    if (request.url.startsWith("/auth/")) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    }
    return payload;
  };
  app.addHook("onSend", avoidAuthResponseCaching);

  app.post(
    "/auth/login",
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (rateLimiter) {
          const decision = await rateLimiter.consume({
            scope: "authentication.login",
            subject: request.ip,
            requestId: request.id,
            correlationId:
              request.observabilityContext?.correlationId ?? request.id,
            limit: config.AUTH_LOGIN_RATE_LIMIT_MAX,
            windowMs: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
          });
          if (!decision.allowed) {
            request.log.warn(
              {
                ...request.observabilityContext,
                eventType: "rate_limit_triggered",
                scope: "authentication.login",
                subjectHash: hashRateLimitIdentity(request.ip),
                resetAt: decision.resetAt.toISOString(),
              },
              "Authentication rate limit exceeded",
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
        } else {
          if (config.NODE_ENV === "production") {
            request.log.error(
              {
                ...request.observabilityContext,
                eventType: "rate_limit_unavailable",
                scope: "authentication.login",
              },
              "Shared authentication rate limiter is not configured",
            );
            return reply.status(503).send({
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "The service is temporarily unavailable.",
              },
            });
          }

          const limiter = (loginRateLimit ??= app.rateLimit({
            max: config.AUTH_LOGIN_RATE_LIMIT_MAX,
            timeWindow: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
            onExceeded: (request: FastifyRequest) => {
              request.log.warn(
                {
                  ...request.observabilityContext,
                  eventType: "rate_limit_triggered",
                  scope: "authentication.login",
                  subjectHash: hashRateLimitIdentity(request.ip),
                },
                "Authentication rate limit exceeded",
              );
            },
          }));
          await limiter(request, reply);
          if (reply.sent) return reply;
        }
        if (!validateMutationOrigin(request, reply, config)) return reply;
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "BAD_REQUEST", "Invalid login request.");
      }
      const now = new Date();
      const { email, password } = parsed.data;
      let user = await identity.findUserByEmail(email);

      if (
        user?.status === "LOCKED" &&
        user.lockedUntil &&
        user.lockedUntil <= now
      ) {
        const metadata = requestMetadata(request);
        const unlocked = await identity.activateExpiredLock(
          user.id,
          metadata.requestId,
          metadata.ipAddress,
          metadata.userAgent,
          now,
          metadata.correlationId,
        );
        if (unlocked) {
          user = await identity.findUserByEmail(email);
        }
      }

      let authenticatedUser: IdentityUser | undefined;
      if (user?.status === "ACTIVE" && user.passwordHash) {
        if (await verifyPassword(user.passwordHash, password)) {
          authenticatedUser = user;
        }
      } else {
        await verifyPassword(await dummyPasswordHash, password);
      }

      if (!authenticatedUser) {
        const failed =
          user?.status === "ACTIVE"
            ? await identity.recordFailedLogin(
                email,
                now,
                FAILURE_WINDOW_MS,
                ACCOUNT_FAILURE_THRESHOLD,
                ACCOUNT_LOCK_MS,
                request.id,
                request.ip.slice(0, 45),
                (request.headers["user-agent"] ?? "").slice(0, 512),
                request.observabilityContext?.correlationId ?? request.id,
              )
            : undefined;
        if (!failed) {
          await identity.recordAuthenticationEvent(
            authenticationAudit(request, {
              action: "AUTH_LOGIN_FAILURE",
              actorUserId: user?.id ?? null,
              result: "FAILURE",
              reason: "invalid_credentials",
            }),
          );
        }
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Email or password is incorrect.",
        );
      }

      if (request.cookies[SESSION_COOKIE] && request.auth) {
        await identity.revokeSession(
          sessionDigest(request.cookies[SESSION_COOKIE] ?? ""),
          request.id,
          request.ip,
          request.headers["user-agent"] ?? "",
          now,
          request.observabilityContext?.correlationId ?? request.id,
        );
      }

      const secret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(
        now.getTime() + config.AUTH_SESSION_TTL_SECONDS * 1_000,
      );
      await identity.createSession(
        {
          secretHash: sessionDigest(secret),
          userId: authenticatedUser.id,
          organizationId: null,
          branchId: null,
          expiresAt,
          ipAddress: request.ip.slice(0, 45),
          userAgent: (request.headers["user-agent"] ?? "").slice(0, 512),
        },
        request.id,
        now,
        request.observabilityContext?.correlationId ?? request.id,
      );
      reply.setCookie(SESSION_COOKIE, secret, {
        ...cookieOptions(config),
        maxAge: config.AUTH_SESSION_TTL_SECONDS,
        expires: expiresAt,
      });
      return reply.send({
        user: {
          id: authenticatedUser.id,
          email: authenticatedUser.email,
          displayName: authenticatedUser.displayName,
        },
        session: { expiresAt: expiresAt.toISOString() },
      });
    },
  );

  app.post(
    "/auth/logout",
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!validateMutationOrigin(request, reply, config)) return reply;
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = request.cookies[SESSION_COOKIE];
      if (secret && sessionSecretSchema.test(secret)) {
        const now = new Date();
        await identity.revokeSession(
          sessionDigest(secret),
          request.id,
          request.ip,
          request.headers["user-agent"] ?? "",
          now,
          request.observabilityContext?.correlationId ?? request.id,
        );
      }
      clearSessionCookie(reply, config);
      return reply.status(204).send();
    },
  );

  app.get(
    "/auth/session",
    { preHandler: requireAuthenticated() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      const user = await identity.findUserById(auth.userId);
      if (!user || user.status !== "ACTIVE") {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      const memberships = await identity.listActiveMemberships(auth.userId);
      const activeOrganization = auth.organizationId
        ? memberships.find(
            (membership) => membership.organizationId === auth.organizationId,
          )
        : undefined;
      const availableBranches = auth.organizationId
        ? await identity.listAuthorizedBranches(
            auth.userId,
            auth.organizationId,
          )
        : [];
      return {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        session: { expiresAt: auth.sessionExpiresAt.toISOString() },
        organization: activeOrganization
          ? {
              organizationId: activeOrganization.organizationId,
              name: activeOrganization.name,
              slug: activeOrganization.slug,
            }
          : null,
        memberships: memberships.map(({ organizationId, name, slug }) => ({
          organizationId,
          name,
          slug,
        })),
        availableBranches,
        branch: auth.branchId ? { branchId: auth.branchId } : null,
      };
    },
  );

  app.post(
    "/auth/organization",
    {
      preHandler: [
        requireAuthenticated(),
        async (request: FastifyRequest, reply: FastifyReply) => {
          if (!validateMutationOrigin(request, reply, config)) return reply;
        },
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      const parsed = organizationSelectionSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid organization selection.",
        );
      }
      const secret = request.cookies[SESSION_COOKIE];
      if (!secret || !sessionSecretSchema.test(secret)) {
        clearSessionCookie(reply, config);
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      const metadata = requestMetadata(request);
      const organization = await identity.selectOrganization(
        auth.userId,
        sessionDigest(secret),
        parsed.data.organizationId,
        metadata.requestId,
        metadata.ipAddress,
        metadata.userAgent,
        new Date(),
      );
      if (!organization) {
        await identity.recordAuthenticationEvent(
          authenticationAudit(request, {
            action: "AUTH_ORGANIZATION_SELECTED",
            actorUserId: auth.userId,
            result: "FAILURE",
            reason: "active_membership_required",
          }),
        );
        return sendError(
          reply,
          403,
          "FORBIDDEN",
          "Organization membership is required.",
        );
      }
      auth.organizationId = organization.organizationId;
      auth.membershipId = organization.membershipId;
      auth.branchId = null;
      return {
        organization: {
          organizationId: organization.organizationId,
          name: organization.name,
          slug: organization.slug,
        },
      };
    },
  );

  app.post(
    "/auth/branch",
    {
      preHandler: [
        requireAuthenticated(),
        async (request: FastifyRequest, reply: FastifyReply) => {
          if (!validateMutationOrigin(request, reply, config)) return reply;
        },
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      if (!auth.organizationId || !auth.membershipId) {
        return sendError(
          reply,
          403,
          "FORBIDDEN",
          "An active organization context is required.",
        );
      }
      const parsed = branchSelectionSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid branch selection.",
        );
      }
      const secret = request.cookies[SESSION_COOKIE];
      if (!secret || !sessionSecretSchema.test(secret)) {
        clearSessionCookie(reply, config);
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      const metadata = requestMetadata(request);
      const branch = await identity.selectBranch(
        auth.userId,
        sessionDigest(secret),
        auth.organizationId,
        parsed.data.branchId,
        metadata.requestId,
        metadata.ipAddress,
        metadata.userAgent,
        new Date(),
      );
      if (!branch) {
        await identity.recordAuthenticationEvent(
          authenticationAudit(request, {
            action: "AUTH_BRANCH_SELECTED",
            actorUserId: auth.userId,
            resourceId: parsed.data.branchId,
            result: "FAILURE",
            reason: "active_branch_access_required",
          }),
        );
        return sendError(reply, 403, "FORBIDDEN", "Branch access is required.");
      }
      auth.branchId = branch.branchId;
      return { branch };
    },
  );
}
