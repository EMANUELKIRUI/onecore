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
import { integrations, webhookSubscriptions } from "@onecore/database";
import type { SecretReference, SecretStore } from "@onecore/core-domain";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";
import { getRequestContext } from "@onecore/config";

function allowOnlyTestTenant(
  organizationId: string,
  transaction: OrganizationTransaction = {} as OrganizationTransaction,
): AuthorizationService {
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
    const value = await operation(transaction, resolvedContext);
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
    const readinessCheck = vi.fn(async () => {});
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
      undefined,
      { readinessCheck },
    );
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(readinessCheck).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects disallowed origins on state-changing routes", async () => {
    const app = buildApp(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        AUTH_ALLOWED_ORIGINS: "https://business.example",
      }),
      new MemoryIdentityRepository(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/organizations/00000000-0000-4000-8000-000000000101/branches",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      payload: { name: "Branch", code: "BR-1" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(response.json().error.message).toBe(
      "The request origin is not allowed.",
    );
    const crossSiteFetch = await app.inject({
      method: "POST",
      url: "/organizations/00000000-0000-4000-8000-000000000101/branches",
      headers: {
        origin: "https://business.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      payload: { name: "Branch", code: "BR-2" },
    });
    expect(crossSiteFetch.statusCode).toBe(403);

    const allowedOrigin = await app.inject({
      method: "POST",
      url: "/organizations/00000000-0000-4000-8000-000000000101/branches",
      headers: {
        origin: "https://business.example",
        "content-type": "application/json",
      },
      payload: { name: "Branch", code: "BR-3" },
    });
    expect(allowedOrigin.statusCode).toBe(401);

    await app.close();
  });

  it("requires explicit frontend origins for mutation requests through the API proxy", async () => {
    const headers = {
      host: "onecore-api.onrender.com",
      origin: "https://business.example",
      "content-type": "application/json",
    };
    const unconfiguredApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const rejected = await unconfiguredApp.inject({
      method: "POST",
      url: "/auth/logout",
      headers,
      payload: {},
    });

    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("FORBIDDEN");
    await unconfiguredApp.close();

    const configuredApp = buildApp(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        AUTH_ALLOWED_ORIGINS: "https://business.example",
      }),
      new MemoryIdentityRepository(),
    );
    const accepted = await configuredApp.inject({
      method: "POST",
      url: "/auth/logout",
      headers,
      payload: {},
    });

    expect(accepted.statusCode).toBe(204);
    await configuredApp.close();
  });

  it("reports ready when the required dependency check succeeds", async () => {
    const readinessCheck = vi.fn(async () => {});
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
      undefined,
      { readinessCheck },
    );
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const legacyReady = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect(legacyReady.statusCode).toBe(200);
    expect(readinessCheck).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("keeps liveness independent and fails readiness without leaking errors", async () => {
    const readinessCheck = vi.fn(async () => {
      throw new Error(
        "database connection failed: postgresql://private:secret@db.invalid/app",
      );
    });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
      undefined,
      { readinessCheck },
    );
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready" });
    expect(ready.body).not.toContain("database connection");
    expect(ready.body).not.toContain("secret");
    expect(readinessCheck).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns not ready when the dependency check exceeds its timeout", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
      undefined,
      { readinessCheck: () => new Promise<void>(() => {}) },
    );
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready" });
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

  it("fails closed for unauthenticated credential and webhook operations", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const organizationId = crypto.randomUUID();
    const integrationId = crypto.randomUUID();
    const webhookId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const workflowExecutionId = crypto.randomUUID();
    const fakeSigningValue = "not-a-production-credential-1234567890";
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/integrations/${integrationId}/credentials`,
      }),
      app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/integrations/${integrationId}/credentials`,
        payload: { secret: fakeSigningValue },
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/webhooks`,
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/webhooks/${webhookId}/deliveries`,
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/webhooks/${webhookId}/deliveries/${deliveryId}/attempts`,
      }),
      app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/webhooks`,
        payload: {
          integrationId,
          endpointUrl: "https://hooks.example.org/events",
          eventTypes: ["USER_CREATED"],
          signingSecret: fakeSigningValue,
        },
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/workflow-executions`,
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/workflow-executions/${workflowExecutionId}`,
      }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      401, 401, 401, 401, 401, 401, 401, 401,
    ]);
    expect(
      responses.every(({ body }) => !body.includes(fakeSigningValue)),
    ).toBe(true);
    await app.close();
  });

  it("stores an integration credential without returning or auditing secret material", async () => {
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const integrationId = crypto.randomUUID();
    const sessionSecret = "c".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: userId,
      email: "credential-test@example.test",
      displayName: "Credential Test",
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(userId, {
      organizationId,
      name: "Credential Test",
      slug: "credential-test",
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

    const storedIntegration = {
      id: integrationId,
      secretReference: null as string | null,
    };
    const updates: unknown[] = [];
    const auditWrites: unknown[] = [];
    let outboxWrites = 0;
    const transaction = {
      select: () => {
        let source: unknown;
        const query = {
          from(table: unknown) {
            source = table;
            return query;
          },
          where() {
            return query;
          },
          for() {
            return query;
          },
          limit: async () =>
            source === integrations ? [storedIntegration] : [],
        };
        return query;
      },
      update: () => ({
        set(values: unknown) {
          updates.push(values);
          Object.assign(storedIntegration, values);
          return { where: async () => [] };
        },
      }),
      insert: () => ({
        values(values: unknown) {
          auditWrites.push(values);
          return Promise.resolve([]);
        },
      }),
      execute: async () => {
        outboxWrites += 1;
        return { rows: [] };
      },
    } as unknown as OrganizationTransaction;
    const secretValue = "fixture-only-secret-value-not-for-production";
    const secretStore: SecretStore = {
      store: vi
        .fn<SecretStore["store"]>()
        .mockResolvedValueOnce("opaque-test-reference-1" as SecretReference)
        .mockResolvedValueOnce("opaque-test-reference-2" as SecretReference),
      rotate: vi
        .fn<SecretStore["rotate"]>()
        .mockResolvedValueOnce("opaque-test-reference-2" as SecretReference),
      withSecret: vi.fn(async (_input, use) =>
        use(new TextEncoder().encode(secretValue)),
      ),
      delete: vi.fn(async () => undefined),
      metadata: vi.fn(async () => ({
        createdAt: new Date("2026-10-07T12:00:00.000Z"),
        updatedAt: new Date("2026-10-07T12:00:00.000Z"),
        version: 1,
      })),
    };
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowOnlyTestTenant(organizationId, transaction),
      { secretStore },
    );

    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/integrations/${integrationId}/credentials`,
      cookies: { onecore_session: sessionSecret },
      payload: { secret: secretValue },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ credential: { configured: true } });
    expect(created.body).not.toContain(secretValue);
    expect(created.body).not.toContain("opaque-test-reference");
    expect(secretStore.store).toHaveBeenCalledWith({
      organizationId,
      purpose: "INTEGRATION_CREDENTIAL",
      value: new TextEncoder().encode(secretValue),
    });

    const metadata = await app.inject({
      method: "GET",
      url: `/organizations/${organizationId}/integrations/${integrationId}/credentials`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      credential: { configured: true, version: 1 },
    });
    expect(metadata.body).not.toContain("opaque-test-reference");

    const replacementValue = "fixture-only-replacement-secret-not-production";
    const rotated = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/integrations/${integrationId}/credentials/rotate`,
      cookies: { onecore_session: sessionSecret },
      payload: { secret: replacementValue },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain(replacementValue);
    expect(rotated.body).not.toContain("opaque-test-reference");
    expect(secretStore.delete).toHaveBeenCalledWith({
      organizationId,
      purpose: "INTEGRATION_CREDENTIAL",
      reference: "opaque-test-reference-1",
    });

    const revoked = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/integrations/${integrationId}/credentials`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(revoked.statusCode).toBe(204);
    expect(storedIntegration.secretReference).toBeNull();
    expect(secretStore.delete).toHaveBeenCalledWith({
      organizationId,
      purpose: "INTEGRATION_CREDENTIAL",
      reference: "opaque-test-reference-2",
    });
    expect(JSON.stringify(auditWrites)).not.toContain(secretValue);
    expect(JSON.stringify(auditWrites)).not.toContain(replacementValue);
    expect(JSON.stringify(auditWrites)).not.toContain("opaque-test-reference");
    expect(updates).toHaveLength(3);
    expect(outboxWrites).toBe(3);
    await app.close();

    const failClosedApp = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowOnlyTestTenant(organizationId, transaction),
    );
    const unavailable = await failClosedApp.inject({
      method: "POST",
      url: `/organizations/${organizationId}/integrations/${integrationId}/credentials`,
      cookies: { onecore_session: sessionSecret },
      payload: { secret: "fixture-only-no-backend-secret" },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: {
        code: "INTEGRATION_BACKEND_UNAVAILABLE",
        message: "The integration security backend is unavailable.",
      },
    });
    expect(unavailable.body).not.toContain("fixture-only-no-backend-secret");
    await failClosedApp.close();
  });

  it("manages webhook subscriptions without returning signing secrets or references", async () => {
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const integrationId = crypto.randomUUID();
    const webhookId = crypto.randomUUID();
    const sessionSecret = "d".repeat(43);
    const secretHash = createHash("sha256").update(sessionSecret).digest("hex");
    const identity = new MemoryIdentityRepository();
    identity.addUser({
      id: userId,
      email: "webhook-test@example.test",
      displayName: "Webhook Test",
      status: "ACTIVE",
      passwordHash: null,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    identity.addMembership(userId, {
      organizationId,
      name: "Webhook Test",
      slug: "webhook-test",
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

    const integration = {
      id: integrationId,
      provider: "WEBHOOK",
      status: "PENDING",
    };
    const subscription: Record<string, unknown> = {
      id: webhookId,
      organizationId,
      integrationId,
      endpointUrl: "https://hooks.example.org/events",
      eventTypes: ["USER_CREATED"],
      status: "ACTIVE",
      description: null,
      signingSecretReference: null,
      createdAt: new Date("2026-10-07T12:00:00.000Z"),
      updatedAt: new Date("2026-10-07T12:00:00.000Z"),
    };
    const auditWrites: unknown[] = [];
    let outboxWrites = 0;
    const transaction = {
      select: () => {
        let source: unknown;
        const query = {
          from(table: unknown) {
            source = table;
            return query;
          },
          where() {
            return query;
          },
          for() {
            return query;
          },
          orderBy() {
            return query;
          },
          limit: async () =>
            source === integrations
              ? [integration]
              : source === webhookSubscriptions
                ? [subscription]
                : [],
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (error: unknown) => unknown,
          ) =>
            Promise.resolve(
              source === webhookSubscriptions ? [subscription] : [],
            ).then(resolve, reject),
        };
        return query;
      },
      insert: (table: unknown) => {
        const query = {
          values(values: unknown) {
            if (table === webhookSubscriptions) {
              Object.assign(subscription, values);
            } else {
              auditWrites.push(values);
            }
            return query;
          },
          returning: async () => [subscription],
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve([]).then(resolve, reject),
        };
        return query;
      },
      update: (table: unknown) => {
        const query = {
          set(values: unknown) {
            if (table === webhookSubscriptions) {
              Object.assign(subscription, values);
            }
            return query;
          },
          where() {
            return query;
          },
          returning: async () => [subscription],
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve([]).then(resolve, reject),
        };
        return query;
      },
      execute: async () => {
        outboxWrites += 1;
        return { rows: [] };
      },
    } as unknown as OrganizationTransaction;
    const signingValue = "fixture-only-webhook-signing-key-1234567890";
    const replacementSigningValue =
      "fixture-only-rotated-signing-key-123456789";
    const secretStore: SecretStore = {
      store: vi
        .fn<SecretStore["store"]>()
        .mockResolvedValueOnce("opaque-webhook-reference-1" as SecretReference)
        .mockResolvedValueOnce("opaque-webhook-reference-2" as SecretReference),
      rotate: vi
        .fn<SecretStore["rotate"]>()
        .mockResolvedValueOnce("opaque-webhook-reference-2" as SecretReference),
      withSecret: vi.fn(async (_input, use) =>
        use(new TextEncoder().encode(signingValue)),
      ),
      delete: vi.fn(async () => undefined),
      metadata: vi.fn(async () => undefined),
    };
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      allowOnlyTestTenant(organizationId, transaction),
      { secretStore },
    );

    const created = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/webhooks`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        integrationId,
        endpointUrl: "https://hooks.example.org/events",
        eventTypes: ["USER_CREATED"],
        signingSecret: signingValue,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().webhook).toMatchObject({
      id: webhookId,
      status: "ACTIVE",
      hasSigningSecret: true,
    });
    expect(created.body).not.toContain(signingValue);
    expect(created.body).not.toContain("opaque-webhook-reference-1");

    const updated = await app.inject({
      method: "PATCH",
      url: `/organizations/${organizationId}/webhooks/${webhookId}`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        endpointUrl: "https://hooks.example.org/v2/events",
        eventTypes: ["USER_CREATED", "USER_INVITED"],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain("opaque-webhook-reference-1");

    const rotated = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/webhooks/${webhookId}/rotate-secret`,
      cookies: { onecore_session: sessionSecret },
      payload: { signingSecret: replacementSigningValue },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain(replacementSigningValue);
    expect(rotated.body).not.toContain("opaque-webhook-reference-2");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/organizations/${organizationId}/webhooks/${webhookId}`,
      cookies: { onecore_session: sessionSecret },
    });
    expect(deleted.statusCode).toBe(204);
    expect(subscription).toMatchObject({
      status: "DISABLED",
      signingSecretReference: null,
    });
    expect(secretStore.delete).toHaveBeenCalledWith({
      organizationId,
      purpose: "WEBHOOK_SIGNING",
      reference: "opaque-webhook-reference-2",
    });
    expect(JSON.stringify(auditWrites)).not.toContain(signingValue);
    expect(JSON.stringify(auditWrites)).not.toContain(replacementSigningValue);
    expect(JSON.stringify(auditWrites)).not.toContain(
      "opaque-webhook-reference",
    );
    expect(outboxWrites).toBe(4);
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
    const credentialPermissionDenied = await authenticatedApp.inject({
      method: "POST",
      url: `/organizations/${organizationId}/integrations/${crypto.randomUUID()}/credentials`,
      cookies: { onecore_session: sessionSecret },
      payload: { secret: "fixture-only-authorized-test-value" },
    });
    expect(credentialPermissionDenied.statusCode).toBe(403);
    expect(credentialPermissionDenied.body).not.toContain(
      "fixture-only-authorized-test-value",
    );
    const webhookPermissionDenied = await authenticatedApp.inject({
      method: "POST",
      url: `/organizations/${organizationId}/webhooks`,
      cookies: { onecore_session: sessionSecret },
      payload: {
        integrationId: crypto.randomUUID(),
        endpointUrl: "https://hooks.example.org/events",
        eventTypes: ["USER_CREATED"],
        signingSecret: "fixture-only-webhook-signing-secret-123456",
      },
    });
    expect(webhookPermissionDenied.statusCode).toBe(403);
    expect(webhookPermissionDenied.body).not.toContain(
      "fixture-only-webhook-signing-secret-123456",
    );
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
      `/organizations/${organizationB}/integrations/${crypto.randomUUID()}/credentials`,
      `/organizations/${organizationB}/webhooks`,
      `/organizations/${organizationB}/webhooks/${crypto.randomUUID()}/deliveries`,
      `/organizations/${organizationB}/communication-templates`,
      `/organizations/${organizationB}/notification-preferences`,
      `/organizations/${organizationB}/notification-preferences/defaults`,
      `/organizations/${organizationB}/communication-providers`,
      `/organizations/${organizationB}/communications/deliveries`,
      `/organizations/${organizationB}/notifications`,
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

  it("rejects anonymous communication, template, preference, provider, and inbox operations", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const organizationId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const cases = [
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/communication-templates`,
      }),
      app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/communication-templates`,
        payload: {
          key: "test.notice",
          channel: "EMAIL",
          locale: "en",
          subject: "Notice",
          body: "Hello {{customer.name}}",
          variables: ["customer.name"],
        },
      }),
      app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/communication-templates/${templateId}/versions/${versionId}/publish`,
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/notification-preferences`,
      }),
      app.inject({
        method: "PUT",
        url: `/organizations/${organizationId}/notification-preferences`,
        payload: { locale: "fr-CA" },
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/notification-preferences/defaults`,
      }),
      app.inject({
        method: "PUT",
        url: `/organizations/${organizationId}/notification-preferences/defaults`,
        payload: {
          preferences: [
            { channel: "EMAIL", category: "ACCOUNT_NOTICE", enabled: true },
          ],
        },
      }),
      app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/communications`,
        payload: {
          channel: "EMAIL",
          recipientUserId: crypto.randomUUID(),
          category: "ACCOUNT_NOTICE",
          templateKey: "test.notice",
          variables: { "customer.name": "Test" },
        },
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/communications/deliveries`,
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/communications/deliveries/${deliveryId}/attempts`,
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/communication-providers`,
      }),
      app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/communication-providers`,
        payload: {
          integrationId: crypto.randomUUID(),
          channel: "EMAIL",
          providerKey: "test.email",
          configuration: { senderName: "Test" },
        },
      }),
      app.inject({
        method: "GET",
        url: `/organizations/${organizationId}/notifications`,
      }),
      app.inject({
        method: "POST",
        url: `/organizations/${organizationId}/notifications/${crypto.randomUUID()}/read`,
      }),
    ];
    const responses = await Promise.all(cases);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual(
      Array(cases.length).fill(401),
    );
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
