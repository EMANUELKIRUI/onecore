import { createHash } from "node:crypto";
import { loadConfig } from "@onecore/config";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  OrganizationTransaction,
  ResolvedAuthorizationContext,
} from "@onecore/database";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";
import { getRequestContext } from "@onecore/config";

function allowOnlyTestTenant(organizationId: string): AuthorizationService {
  const withPermission = async (
    context: AuthorizationContext | null,
    _permissionKey: string,
    _metadata: AuthorizationMetadata,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<unknown>,
  ): Promise<AuthorizationResult<unknown>> => {
    const membershipId = context?.membershipId;
    if (
      !context ||
      !membershipId ||
      context.organizationId !== organizationId
    ) {
      return {
        allowed: false,
        statusCode: context ? 403 : 401,
        dataScopes: [],
      };
    }
    const resolvedContext = {
      ...context,
      organizationId,
      membershipId,
      branch: context.branchId
        ? { branchId: context.branchId, name: "Tenant A Branch", code: "A" }
        : null,
      branchAccessMode: "ALL" as const,
      roles: [],
      platformRoles: [],
      permissions: [],
    };
    const value = await operation(
      {} as OrganizationTransaction,
      resolvedContext,
    );
    return {
      allowed: true,
      value,
      context: resolvedContext,
    };
  };
  return { withPermission } as unknown as AuthorizationService;
}

describe("API foundation", () => {
  it("serves a liveness response", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("keeps liveness independent from database readiness", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
      undefined,
      {
        readinessCheck: async () => {
          throw new Error("database connection detail");
        },
      },
    );
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready" });
    expect(ready.body).not.toContain("database connection detail");
    await app.close();
  });

  it("does not report readiness when no dependency check is configured", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    await app.close();
  });

  it("fails closed when the configured database-backed limiter rejects login", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
      undefined,
      {
        rateLimiter: {
          consume: async () => ({
            allowed: false,
            remaining: 0,
            resetAt: new Date(Date.now() + 30_000),
          }),
        },
      },
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "test@example.test", password: "fake-password" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests. Try again later.",
      },
    });
    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.body).not.toContain("fake-password");
    await app.close();
  });

  it("refuses production login when the shared limiter is not configured", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "production", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "test@example.test", password: "fake-password" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable.",
      },
    });
    expect(response.body).not.toContain("fake-password");
    await app.close();
  });

  it("fails closed in production when a shared login limiter is not configured", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "production", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "test@example.test", password: "fake-password" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable.",
      },
    });
    expect(response.body).not.toContain("fake-password");
    await app.close();
  });

  it("propagates validated request and correlation IDs without client identity claims", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    app.get("/context-test", async (request) => ({
      current: getRequestContext(),
      request: request.observabilityContext,
    }));
    const requestId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const valid = await app.inject({
      method: "GET",
      url: "/context-test",
      headers: {
        "x-request-id": requestId,
        "x-correlation-id": correlationId,
      },
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/context-test",
      headers: {
        "x-request-id": "invalid",
        "x-correlation-id": "invalid",
      },
    });

    expect(valid.headers["x-request-id"]).toBe(requestId);
    expect(valid.headers["x-correlation-id"]).toBe(correlationId);
    expect(valid.json().current).toMatchObject({
      requestId,
      correlationId,
      userId: null,
      organizationId: null,
      branchId: null,
    });
    expect(invalid.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(invalid.headers["x-correlation-id"]).toBe(
      invalid.headers["x-request-id"],
    );
    expect(valid.headers["x-content-type-options"]).toBe("nosniff");
    expect(valid.headers["x-frame-options"]).toBe("DENY");
    expect(valid.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("adds actor and tenant context only from a validated server-side session", async () => {
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const sessionSecret = "c".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: userId,
      email: "observability@example.test",
      displayName: "Observability Test",
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(userId, {
      organizationId,
      name: "Verified Organization",
      slug: "verified-organization",
    });
    identity.sessions.set(secretHash, {
      id: crypto.randomUUID(),
      secretHash,
      userId,
      organizationId,
      branchId: null,
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: new Date(),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
    );
    app.get("/context-test", async () => getRequestContext());
    const response = await app.inject({
      method: "GET",
      url: "/context-test",
      cookies: { onecore_session: sessionSecret },
      headers: {
        "x-user-id": crypto.randomUUID(),
        "x-organization-id": crypto.randomUUID(),
        "x-branch-id": crypto.randomUUID(),
      },
    });

    expect(response.json()).toMatchObject({
      userId,
      organizationId,
      branchId: null,
    });
    await app.close();
  });

  it("returns a stable error contract for unknown routes", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const response = await app.inject({ method: "GET", url: "/not-a-route" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    });
    await app.close();
  });

  it("protects authorization endpoints with generic 401 and 403 responses", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const anonymous = await app.inject({
      method: "GET",
      url: "/permissions",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication is required.",
      },
    });
    const anonymousModuleCatalog = await app.inject({
      method: "GET",
      url: "/modules",
    });
    expect(anonymousModuleCatalog.statusCode).toBe(401);
    const anonymousConfiguration = await app.inject({
      method: "GET",
      url: `/organizations/${crypto.randomUUID()}/configuration`,
    });
    expect(anonymousConfiguration.statusCode).toBe(401);
    const anonymousFeatureMutation = await app.inject({
      method: "PATCH",
      url: `/organizations/${crypto.randomUUID()}/features/ENABLE_AI`,
      payload: { enabled: true },
    });
    expect(anonymousFeatureMutation.statusCode).toBe(401);
    const anonymousCustomFields = await app.inject({
      method: "GET",
      url: `/organizations/${crypto.randomUUID()}/custom-fields`,
    });
    expect(anonymousCustomFields.statusCode).toBe(401);
    const anonymousWorkflows = await app.inject({
      method: "GET",
      url: `/organizations/${crypto.randomUUID()}/workflows`,
    });
    expect(anonymousWorkflows.statusCode).toBe(401);
    const anonymousEventDispatch = await app.inject({
      method: "POST",
      url: `/organizations/${crypto.randomUUID()}/events/dispatch`,
      payload: {},
    });
    expect(anonymousEventDispatch.statusCode).toBe(401);
    const anonymousEventReplay = await app.inject({
      method: "POST",
      url: `/organizations/${crypto.randomUUID()}/events/dead-letters/${crypto.randomUUID()}/platform.audit.configuration_changed/replay`,
    });
    expect(anonymousEventReplay.statusCode).toBe(401);
    const arbitraryEventPublish = await app.inject({
      method: "POST",
      url: `/organizations/${crypto.randomUUID()}/events`,
      payload: { eventType: "ORGANIZATION_CREATED", payload: {} },
    });
    expect(arbitraryEventPublish.statusCode).toBe(404);
    const anonymousDomains = await app.inject({
      method: "GET",
      url: `/organizations/${crypto.randomUUID()}/domains`,
    });
    expect(anonymousDomains.statusCode).toBe(401);
    const clientSuppliedBranch = await app.inject({
      method: "PATCH",
      url: `/organizations/${crypto.randomUUID()}/features/BRANCH_FLAG`,
      payload: {
        scope: "BRANCH",
        branchId: crypto.randomUUID(),
        enabled: true,
      },
    });
    expect(clientSuppliedBranch.statusCode).toBe(400);
    const executableCustomFieldMetadata = await app.inject({
      method: "POST",
      url: `/organizations/${crypto.randomUUID()}/custom-fields`,
      payload: {
        entityType: "test_record",
        key: "unsafe_field",
        label: "Unsafe Field",
        fieldType: "TEXT",
        validation: { script: "return true" },
      },
    });
    expect(executableCustomFieldMetadata.statusCode).toBe(400);
    const executableWorkflowAction = await app.inject({
      method: "POST",
      url: `/organizations/${crypto.randomUUID()}/workflows/${crypto.randomUUID()}/versions`,
      payload: {
        steps: [{ key: "start", name: "Start", position: 0 }],
        actions: [
          {
            stepKey: "start",
            actionType: "NOTIFICATION",
            configuration: { script: "DROP TABLE organizations" },
          },
        ],
      },
    });
    expect(executableWorkflowAction.statusCode).toBe(400);
    const secretBearingIntegration = await app.inject({
      method: "POST",
      url: `/organizations/${crypto.randomUUID()}/integrations`,
      payload: {
        key: "gateway",
        provider: "PAYMENT_GATEWAY",
        apiKey: "must-not-be-accepted",
      },
    });
    expect(secretBearingIntegration.statusCode).toBe(400);

    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionSecret = "a".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: userId,
      email: "authorized@example.test",
      displayName: "Authorization Test",
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(userId, {
      organizationId,
      name: "Authorization Test",
      slug: "authorization-test",
    });
    identity.sessions.set(secretHash, {
      id: sessionId,
      secretHash,
      userId,
      organizationId,
      branchId: null,
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: new Date(),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });
    const authenticatedApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
    );
    const denied = await authenticatedApp.inject({
      method: "GET",
      url: "/permissions",
      cookies: { onecore_session: sessionSecret },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "The request is not authorized.",
      },
    });
    const moduleDenied = await authenticatedApp.inject({
      method: "GET",
      url: "/modules",
      cookies: { onecore_session: sessionSecret },
    });
    expect(moduleDenied.statusCode).toBe(403);
    const eventReplayDenied = await authenticatedApp.inject({
      method: "POST",
      url: `/organizations/${organizationId}/events/dead-letters/${crypto.randomUUID()}/platform.audit.configuration_changed/replay`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(eventReplayDenied.statusCode).toBe(403);
    const configurationDenied = await authenticatedApp.inject({
      method: "GET",
      url: `/organizations/${organizationId}/configuration`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(configurationDenied.statusCode).toBe(403);
    await authenticatedApp.close();
    await app.close();
  });

  it("does not let configuration route IDs switch the verified organization or branch", async () => {
    const userId = crypto.randomUUID();
    const organizationA = crypto.randomUUID();
    const organizationB = crypto.randomUUID();
    const branchA = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionSecret = "b".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: userId,
      email: "tenant-boundary@example.test",
      displayName: "Tenant Boundary Test",
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(userId, {
      organizationId: organizationA,
      name: "Tenant A",
      slug: "tenant-a",
      branchAccessMode: "ALL",
    });
    identity.addOrganizationBranch(organizationA, {
      branchId: branchA,
      name: "Tenant A Branch",
      code: "A",
    });
    identity.sessions.set(secretHash, {
      id: sessionId,
      secretHash,
      userId,
      organizationId: organizationA,
      branchId: branchA,
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: new Date(),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowOnlyTestTenant(organizationA),
    );

    for (const url of [
      `/organizations/${organizationB}/configuration`,
      `/organizations/${organizationB}/features`,
      `/organizations/${organizationB}/custom-fields`,
      `/organizations/${organizationB}/workflows`,
      `/organizations/${organizationB}/notification-settings`,
      `/organizations/${organizationB}/integrations`,
      `/organizations/${organizationB}/domains`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        cookies: { onecore_session: sessionSecret },
      });
      expect(response.statusCode, url).toBe(404);
    }

    const forgedOrganizationDispatch = await app.inject({
      method: "POST",
      url: `/organizations/${organizationB}/events/dispatch`,
      cookies: { onecore_session: sessionSecret },
      payload: {},
    });
    expect(forgedOrganizationDispatch.statusCode).toBe(404);
    const forgedOrganizationReplay = await app.inject({
      method: "POST",
      url: `/organizations/${organizationB}/events/dead-letters/${crypto.randomUUID()}/platform.audit.configuration_changed/replay`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(forgedOrganizationReplay.statusCode).toBe(404);

    const foreignBranch = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationA}/notification-settings`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        events: [
          {
            event: "APPROVAL_REQUESTED",
            channel: "IN_APP",
            enabled: true,
            branchId: crypto.randomUUID(),
            recipientMode: "BRANCH_MANAGERS",
          },
        ],
      },
    });
    expect(foreignBranch.statusCode).toBe(403);
    await app.close();
  });

  it("sanitizes unexpected server errors", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    app.get("/throws", async () => {
      throw new Error("sensitive internal detail");
    });
    const response = await app.inject({ method: "GET", url: "/throws" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    });
    expect(response.body).not.toContain("sensitive internal detail");
    await app.close();
  });
});
