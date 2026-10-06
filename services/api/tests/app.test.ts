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
