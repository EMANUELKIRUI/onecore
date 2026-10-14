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
import {
  buildTotpProvisioningUri,
  decryptSecret,
  encryptSecret,
  generateRandomToken,
  generateTotpSecret,
  hashVerifier,
  sendTransactionalEmail,
  type TransactionalEmailSender,
  verifyTotpStep,
} from "./identity-security.js";

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
const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(1_024),
    newPassword: z.string().min(12).max(1_024),
  })
  .refine(
    ({ currentPassword, newPassword }) => currentPassword !== newPassword,
  );
const mfaChallengeSchema = z.object({
  email: z
    .email()
    .max(320)
    .transform((email) => email.trim().toLowerCase()),
  password: z.string().min(1).max(1_024),
  code: z.string().min(6).max(8),
});
const mfaEnrollmentSchema = z.object({
  email: z
    .email()
    .max(320)
    .transform((email) => email.trim().toLowerCase())
    .optional(),
  password: z.string().min(1).max(1_024).optional(),
  code: z.string().min(6).max(8).optional(),
});
const credentialSetupSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(1_024),
  })
  .strict();
const ownerInvitationPathSchema = z.object({ organizationId: z.uuid() });
const ownerInvitationBodySchema = z.object({}).strict();

const dummyPasswordHash = hashPassword(randomBytes(32), ARGON2_OPTIONS);
const credentialSetupPasswordOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export interface AuthenticatedRequestContext {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  organizationId: string | null;
  membershipId: string | null;
  branchId: string | null;
  mfaVerifiedAt: Date | null;
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
  code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "SERVICE_UNAVAILABLE",
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

export function validateRequestOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: RuntimeConfig,
): boolean {
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

  return validateRequestOrigin(request, reply, config);
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
  emailSender: TransactionalEmailSender = sendTransactionalEmail,
): void {
  app.register(cookie);
  app.register(rateLimit, { global: false });
  app.decorateRequest("auth", null);
  let loginRateLimit: preHandlerAsyncHookHandler | undefined;
  let passwordChangeRateLimit: preHandlerAsyncHookHandler | undefined;
  let mfaChallengeRateLimit: preHandlerAsyncHookHandler | undefined;
  let mfaEnrollmentRateLimit: preHandlerAsyncHookHandler | undefined;
  let ownerInvitationRateLimit: preHandlerAsyncHookHandler | undefined;
  let credentialSetupRateLimit: preHandlerAsyncHookHandler | undefined;

  async function enforceIdentityRateLimit(
    scope: string,
    request: FastifyRequest,
    reply: FastifyReply,
    additionalSubjects: string[] = [],
  ): Promise<boolean> {
    if (rateLimiter) {
      for (const subject of [request.ip, ...additionalSubjects]) {
        const decision = await rateLimiter.consume({
          scope,
          subject,
          requestId: request.id,
          correlationId:
            request.observabilityContext?.correlationId ?? request.id,
          limit: config.AUTH_LOGIN_RATE_LIMIT_MAX,
          windowMs: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
        });
        if (decision.allowed) continue;
        request.log.warn(
          {
            ...request.observabilityContext,
            eventType: "rate_limit_triggered",
            scope,
            subjectHash: hashRateLimitIdentity(subject),
            resetAt: decision.resetAt.toISOString(),
          },
          "Identity operation rate limit exceeded",
        );
        reply.header(
          "retry-after",
          Math.max(
            1,
            Math.ceil((decision.resetAt.getTime() - Date.now()) / 1_000),
          ),
        );
        reply.status(429).send({
          error: {
            code: "TOO_MANY_REQUESTS",
            message: "Too many requests. Try again later.",
          },
        });
        return false;
      }
      return true;
    }
    if (config.NODE_ENV === "production") {
      request.log.error(
        {
          ...request.observabilityContext,
          eventType: "rate_limit_unavailable",
          scope,
        },
        "Shared identity rate limiter is not configured",
      );
      reply.status(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The service is temporarily unavailable.",
        },
      });
      return false;
    }
    const limiter =
      scope === "authentication.owner_invitation"
        ? (ownerInvitationRateLimit ??= app.rateLimit({
            max: config.AUTH_LOGIN_RATE_LIMIT_MAX,
            timeWindow: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
          }))
        : scope === "authentication.mfa_enrollment"
          ? (mfaEnrollmentRateLimit ??= app.rateLimit({
              max: config.AUTH_LOGIN_RATE_LIMIT_MAX,
              timeWindow: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
            }))
          : (credentialSetupRateLimit ??= app.rateLimit({
              max: config.AUTH_LOGIN_RATE_LIMIT_MAX,
              timeWindow: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
            }));
    await limiter(request, reply);
    return !reply.sent;
  }

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
        mfaVerifiedAt: resolved.session.mfaVerifiedAt ?? null,
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
    "/platform/organization-applications/:organizationId/owner-invitation",
    {
      preHandler: [
        requireAuthenticated(),
        async (request: FastifyRequest, reply: FastifyReply) => {
          if (!validateMutationOrigin(request, reply, config)) return reply;
          if (
            !(await enforceIdentityRateLimit(
              "authentication.owner_invitation",
              request,
              reply,
            ))
          ) {
            return reply;
          }
        },
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const path = ownerInvitationPathSchema.safeParse(request.params);
      const body = ownerInvitationBodySchema.safeParse(request.body ?? {});
      if (!path.success || !body.success || !request.auth) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid owner invitation request.",
        );
      }
      if (
        !config.MFA_ENCRYPTION_KEY ||
        !config.BUSINESS_APP_ORIGIN ||
        !config.RESEND_API_KEY ||
        !config.RESEND_FROM_EMAIL
      ) {
        return reply.status(503).send({
          error: {
            code: "OWNER_SETUP_NOT_CONFIGURED",
            message:
              "Owner setup email or mandatory MFA configuration is unavailable.",
          },
          invitation: { status: "DEFERRED" },
        });
      }

      const token = generateRandomToken();
      const now = new Date();
      const event = authenticationAudit(request, {
        action: "AUTH_OWNER_SETUP_INVITATION_ISSUED",
        actorUserId: request.auth.userId,
        organizationId: path.data.organizationId,
        result: "SUCCESS",
      });
      const owner = await identity.issueOwnerCredentialSetup(
        path.data.organizationId,
        request.auth.userId,
        hashVerifier(token),
        new Date(now.getTime() + 60 * 60_000),
        event,
      );
      if (!owner) {
        return sendError(
          reply,
          403,
          "FORBIDDEN",
          "The organization is not eligible for an Owner setup invitation.",
        );
      }

      const setupUrl = new URL("/setup.html", config.BUSINESS_APP_ORIGIN);
      setupUrl.hash = `token=${encodeURIComponent(token)}`;
      const delivery = await emailSender({
        apiKey: config.RESEND_API_KEY,
        fromEmail: config.RESEND_FROM_EMAIL,
        toEmail: owner.email,
        subject: "Set up your OneCore Owner account",
        text: [
          `Hello ${owner.displayName},`,
          "",
          "An administrator has invited you to set up the Owner account for your OneCore organization.",
          "Use this one-time link within 60 minutes to choose your password:",
          setupUrl.toString(),
          "",
          "After setup, sign in and complete the required authenticator-app MFA enrollment.",
          "If you did not expect this invitation, contact OneCore support.",
        ].join("\n"),
        ...(config.RESEND_BASE_URL ? { baseUrl: config.RESEND_BASE_URL } : {}),
      });
      if (!delivery.accepted || delivery.status !== "QUEUED") {
        request.log.warn(
          {
            ...request.observabilityContext,
            eventType: "owner_setup_email_not_accepted",
            organizationId: path.data.organizationId,
            userId: owner.id,
            providerStatus: delivery.status,
          },
          "Owner setup invitation was not accepted by the email provider",
        );
        return reply.status(503).send({
          error: {
            code: "OWNER_SETUP_EMAIL_UNAVAILABLE",
            message:
              delivery.status === "DEFERRED"
                ? "Email delivery is not configured. The invitation was not sent."
                : "The email provider did not accept the invitation. Retry to issue a fresh link.",
          },
          invitation: { status: delivery.status },
        });
      }
      return reply.status(202).send({
        invitation: {
          status: "QUEUED",
          message:
            "The email provider accepted the setup invitation; delivery is not confirmed.",
        },
      });
    },
  );

  app.post(
    "/auth/owner-credential-setup",
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!validateMutationOrigin(request, reply, config)) return reply;
        if (
          !(await enforceIdentityRateLimit(
            "authentication.owner_credential_setup",
            request,
            reply,
          ))
        ) {
          return reply;
        }
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = credentialSetupSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid account setup request.",
        );
      }
      const passwordHash = await hashPassword(
        parsed.data.password,
        credentialSetupPasswordOptions,
      );
      const completed = await identity.completeOwnerCredentialSetup(
        hashVerifier(parsed.data.token),
        passwordHash,
        authenticationAudit(request, {
          action: "AUTH_OWNER_CREDENTIAL_SETUP_COMPLETED",
          result: "SUCCESS",
        }),
      );
      if (!completed) {
        return reply.status(400).send({
          error: {
            code: "OWNER_SETUP_LINK_INVALID",
            message:
              "This setup link is invalid, expired, revoked, or already used. Ask a platform administrator for a new invitation.",
          },
        });
      }
      return reply.status(200).send({
        nextStep: "SIGN_IN_AND_ENROLL_MFA",
        message:
          "Your password is set. Sign in to complete required authenticator setup before accessing OneCore.",
      });
    },
  );

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

      if (await identity.userRequiresMfa(authenticatedUser.id)) {
        const credential = await identity.getMfaCredential(
          authenticatedUser.id,
        );
        return reply.status(403).send({
          error: {
            code: "MFA_REQUIRED",
            message: "Multi-factor authentication is required.",
          },
          mfa: {
            required: true,
            method: "totp",
            status: credential?.enabledAt
              ? "challenge_required"
              : "enrollment_required",
          },
        });
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
    "/auth/mfa/enroll",
    {
      preHandler: [
        async (request: FastifyRequest, reply: FastifyReply) => {
          const parsed = mfaEnrollmentSchema.safeParse(request.body ?? {});
          const accountSubject = parsed.success
            ? parsed.data.email
              ? `account:${hashRateLimitIdentity(parsed.data.email)}`
              : request.auth
                ? `user:${request.auth.userId}`
                : undefined
            : undefined;
          if (
            !(await enforceIdentityRateLimit(
              "authentication.mfa_enrollment",
              request,
              reply,
              accountSubject ? [accountSubject] : [],
            ))
          ) {
            return reply;
          }
          if (!validateMutationOrigin(request, reply, config)) return reply;
        },
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.MFA_ENCRYPTION_KEY) {
        return sendError(
          reply,
          503,
          "SERVICE_UNAVAILABLE",
          "MFA encryption is not configured.",
        );
      }
      const parsed = mfaEnrollmentSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid MFA enrollment request.",
        );
      }
      let user = request.auth
        ? await identity.findUserById(request.auth.userId)
        : undefined;
      if (!request.auth) {
        const { email, password: providedPassword } = parsed.data;
        if (!email || !providedPassword) {
          return sendError(
            reply,
            401,
            "UNAUTHORIZED",
            "Email or password is incorrect.",
          );
        }
        user = await identity.findUserByEmail(email);
        const now = new Date();
        if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
          await verifyPassword(await dummyPasswordHash, providedPassword);
          await identity.recordAuthenticationEvent(
            authenticationAudit(request, {
              action: "AUTH_LOGIN_FAILURE",
              actorUserId: user?.id ?? null,
              result: "FAILURE",
              reason: "invalid_credentials",
            }),
          );
          return sendError(
            reply,
            401,
            "UNAUTHORIZED",
            "Email or password is incorrect.",
          );
        }
        if (!(await verifyPassword(user.passwordHash, providedPassword))) {
          const failed = await identity.recordFailedLogin(
            email,
            now,
            FAILURE_WINDOW_MS,
            ACCOUNT_FAILURE_THRESHOLD,
            ACCOUNT_LOCK_MS,
            request.id,
            request.ip.slice(0, 45),
            (request.headers["user-agent"] ?? "").slice(0, 512),
            request.observabilityContext?.correlationId ?? request.id,
          );
          if (!failed) {
            await identity.recordAuthenticationEvent(
              authenticationAudit(request, {
                action: "AUTH_LOGIN_FAILURE",
                actorUserId: user.id,
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
      }
      if (!user) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }
      if (!(await identity.userRequiresMfa(user.id))) {
        return sendError(
          reply,
          403,
          "FORBIDDEN",
          "MFA enrollment is not available for this account.",
        );
      }
      if (parsed.data.code) {
        const credential = await identity.getMfaCredential(user.id);
        if (
          !credential ||
          credential.enabledAt ||
          credential.enrollmentExpiresAt <= new Date()
        ) {
          return sendError(
            reply,
            400,
            "BAD_REQUEST",
            "MFA enrollment has expired. Start enrollment again.",
          );
        }
        const pendingSecret = decryptSecret(
          credential.secretEncrypted,
          config.MFA_ENCRYPTION_KEY,
        );
        const acceptedStep = verifyTotpStep(pendingSecret, parsed.data.code);
        if (acceptedStep === null) {
          return sendError(
            reply,
            401,
            "UNAUTHORIZED",
            "The MFA code is invalid.",
          );
        }
        const enabled = await identity.completeMfaEnrollment(
          user.id,
          acceptedStep,
          authenticationAudit(request, {
            action: "AUTH_MFA_ENROLLED",
            actorUserId: user.id,
            result: "SUCCESS",
            reason: "totp_enrollment_verified",
          }),
        );
        if (!enabled) {
          return sendError(
            reply,
            400,
            "BAD_REQUEST",
            "MFA enrollment has expired. Start enrollment again.",
          );
        }
        if (!request.auth) {
          const now = new Date();
          const sessionSecret = randomBytes(32).toString("base64url");
          const expiresAt = new Date(
            now.getTime() + config.AUTH_SESSION_TTL_SECONDS * 1_000,
          );
          await identity.createSession(
            {
              secretHash: sessionDigest(sessionSecret),
              userId: user.id,
              organizationId: null,
              branchId: null,
              expiresAt,
              ipAddress: request.ip.slice(0, 45),
              userAgent: (request.headers["user-agent"] ?? "").slice(0, 512),
            },
            request.id,
            now,
            request.observabilityContext?.correlationId ?? request.id,
            true,
          );
          reply.setCookie(SESSION_COOKIE, sessionSecret, {
            ...cookieOptions(config),
            maxAge: config.AUTH_SESSION_TTL_SECONDS,
            expires: expiresAt,
          });
          return reply.send({
            user: {
              id: user.id,
              email: user.email,
              displayName: user.displayName,
            },
            session: { expiresAt: expiresAt.toISOString() },
            mfa: { enabled: true, method: "totp" },
          });
        }
        return reply.send({
          mfa: { enabled: true, method: "totp" },
        });
      }
      const existingCredential = await identity.getMfaCredential(user.id);
      if (existingCredential?.enabledAt) {
        return reply.status(409).send({
          error: {
            code: "CONFLICT",
            message: "MFA is already enabled.",
          },
        });
      }
      const secret = generateTotpSecret();
      const encryptedSecret = encryptSecret(secret, config.MFA_ENCRYPTION_KEY);
      try {
        await identity.storeMfaSecret(
          user.id,
          encryptedSecret,
          new Date(Date.now() + 10 * 60_000),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "MFA is already enabled for this user"
        ) {
          return reply.status(409).send({
            error: { code: "CONFLICT", message: "MFA is already enabled." },
          });
        }
        throw error;
      }
      const uri = buildTotpProvisioningUri(secret, user.email);
      return reply.send({
        mfa: { enabled: false, method: "totp", provisioningUri: uri },
      });
    },
  );

  app.post(
    "/auth/mfa/challenge",
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = mfaChallengeSchema.safeParse(request.body);
        const subjects = [
          request.ip,
          ...(parsed.success
            ? [`account:${hashRateLimitIdentity(parsed.data.email)}`]
            : []),
        ];
        if (rateLimiter) {
          for (const subject of subjects) {
            const decision = await rateLimiter.consume({
              scope: "authentication.mfa_challenge",
              subject,
              requestId: request.id,
              correlationId:
                request.observabilityContext?.correlationId ?? request.id,
              limit: config.AUTH_LOGIN_RATE_LIMIT_MAX,
              windowMs: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
            });
            if (!decision.allowed) {
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
          }
        } else if (config.NODE_ENV === "production") {
          request.log.error(
            {
              ...request.observabilityContext,
              eventType: "rate_limit_unavailable",
              scope: "authentication.mfa_challenge",
            },
            "Shared authentication rate limiter is not configured",
          );
          return reply.status(503).send({
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "The service is temporarily unavailable.",
            },
          });
        } else {
          const limiter = (mfaChallengeRateLimit ??= app.rateLimit({
            max: config.AUTH_LOGIN_RATE_LIMIT_MAX,
            timeWindow: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
            onExceeded: (request: FastifyRequest) => {
              request.log.warn(
                {
                  ...request.observabilityContext,
                  eventType: "rate_limit_triggered",
                  scope: "authentication.mfa_challenge",
                  subjectHash: hashRateLimitIdentity(request.ip),
                },
                "MFA challenge rate limit exceeded",
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
      const parsed = mfaChallengeSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid MFA challenge request.",
        );
      }
      const { email, password, code } = parsed.data;
      const user = await identity.findUserByEmail(email);
      if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
        await verifyPassword(await dummyPasswordHash, password);
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Email or password is incorrect.",
        );
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        await identity.recordFailedLogin(
          email,
          new Date(),
          FAILURE_WINDOW_MS,
          ACCOUNT_FAILURE_THRESHOLD,
          ACCOUNT_LOCK_MS,
          request.id,
          request.ip.slice(0, 45),
          (request.headers["user-agent"] ?? "").slice(0, 512),
          request.observabilityContext?.correlationId ?? request.id,
        );
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Email or password is incorrect.",
        );
      }
      const credential = await identity.getMfaCredential(user.id);
      if (
        !credential?.enabledAt ||
        !config.MFA_ENCRYPTION_KEY ||
        !(await identity.userRequiresMfa(user.id))
      ) {
        return reply.status(403).send({
          error: {
            code: "MFA_REQUIRED",
            message: "Multi-factor authentication is required.",
          },
          mfa: {
            required: true,
            method: "totp",
            status: "enrollment_required",
          },
        });
      }
      const secret = decryptSecret(
        credential.secretEncrypted,
        config.MFA_ENCRYPTION_KEY,
      );
      const acceptedStep = verifyTotpStep(secret, code);
      if (acceptedStep === null) {
        await identity.recordAuthenticationEvent(
          authenticationAudit(request, {
            action: "AUTH_MFA_CHALLENGE_FAILURE",
            actorUserId: user.id,
            result: "FAILURE",
            reason: "invalid_totp",
          }),
        );
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "The MFA code is invalid.",
        );
      }
      const now = new Date();
      const consumed = await identity.consumeMfaTotpStep(
        user.id,
        acceptedStep,
        authenticationAudit(request, {
          action: "AUTH_MFA_CHALLENGE_SUCCESS",
          actorUserId: user.id,
          result: "SUCCESS",
          reason: "totp_step_consumed",
        }),
      );
      if (!consumed) {
        await identity.recordAuthenticationEvent(
          authenticationAudit(request, {
            action: "AUTH_MFA_CHALLENGE_FAILURE",
            actorUserId: user.id,
            result: "FAILURE",
            reason: "totp_replay",
          }),
        );
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "The MFA code is invalid.",
        );
      }
      const sessionSecret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(
        now.getTime() + config.AUTH_SESSION_TTL_SECONDS * 1_000,
      );
      await identity.createSession(
        {
          secretHash: sessionDigest(sessionSecret),
          userId: user.id,
          organizationId: null,
          branchId: null,
          expiresAt,
          ipAddress: request.ip.slice(0, 45),
          userAgent: (request.headers["user-agent"] ?? "").slice(0, 512),
        },
        request.id,
        now,
        request.observabilityContext?.correlationId ?? request.id,
        true,
      );
      reply.setCookie(SESSION_COOKIE, sessionSecret, {
        ...cookieOptions(config),
        maxAge: config.AUTH_SESSION_TTL_SECONDS,
        expires: expiresAt,
      });
      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
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

  app.post(
    "/auth/password/change",
    {
      preHandler: [
        requireAuthenticated(),
        async (request: FastifyRequest, reply: FastifyReply) => {
          if (rateLimiter) {
            const decision = await rateLimiter.consume({
              scope: "authentication.password_change",
              subject: request.ip,
              requestId: request.id,
              correlationId:
                request.observabilityContext?.correlationId ?? request.id,
              limit: config.AUTH_LOGIN_RATE_LIMIT_MAX,
              windowMs: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
            });
            if (!decision.allowed) {
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
                scope: "authentication.password_change",
              },
              "Shared authentication rate limiter is not configured",
            );
            return reply.status(503).send({
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "The service is temporarily unavailable.",
              },
            });
          } else {
            const limiter = (passwordChangeRateLimit ??= app.rateLimit({
              max: config.AUTH_LOGIN_RATE_LIMIT_MAX,
              timeWindow: config.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
            }));
            await limiter(request, reply);
            if (reply.sent) return reply;
          }
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
      const parsed = passwordChangeSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid password change request.",
        );
      }

      const user = await identity.findUserById(auth.userId);
      const secret = request.cookies[SESSION_COOKIE];
      if (
        !user ||
        user.status !== "ACTIVE" ||
        !user.passwordHash ||
        !secret ||
        !sessionSecretSchema.test(secret)
      ) {
        clearSessionCookie(reply, config);
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      }

      const metadata = requestMetadata(request);
      if (
        !(await verifyPassword(user.passwordHash, parsed.data.currentPassword))
      ) {
        await identity.recordAuthenticationEvent(
          authenticationAudit(request, {
            action: "AUTH_PASSWORD_CHANGE_FAILURE",
            actorUserId: user.id,
            resourceId: auth.sessionId,
            result: "FAILURE",
            reason: "current_password_mismatch",
          }),
        );
        return sendError(
          reply,
          403,
          "FORBIDDEN",
          "The current password is incorrect.",
        );
      }

      const newPasswordHash = await hashPassword(
        parsed.data.newPassword,
        ARGON2_OPTIONS,
      );
      const changed = await identity.changePasswordAndRevokeSessions(
        user.id,
        sessionDigest(secret),
        user.passwordHash,
        newPasswordHash,
        {
          action: "AUTH_PASSWORD_CHANGED",
          actorUserId: user.id,
          resourceId: auth.sessionId,
          result: "SUCCESS",
          requestId: metadata.requestId,
          correlationId: metadata.correlationId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          occurredAt: new Date(),
        },
      );
      if (!changed) {
        clearSessionCookie(reply, config);
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
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
