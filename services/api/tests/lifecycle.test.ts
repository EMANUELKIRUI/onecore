import { createHash } from "node:crypto";
import { loadConfig } from "@onecore/config";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  LifecycleMutationService,
  OrganizationTransaction,
  ResolvedAuthorizationContext,
} from "@onecore/database";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { LifecycleMutationError } from "@onecore/database";
import { MemoryIdentityRepository } from "./identity-fixture.js";

function authenticatedIdentity(organizationId: string | null = null) {
  const identity = new MemoryIdentityRepository();
  const userId = crypto.randomUUID();
  const secret = "l".repeat(43);
  const secretHash = createHash("sha256").update(secret).digest("hex");
  identity.addUser({
    id: userId,
    email: `lifecycle-${userId}@example.test`,
    displayName: "Lifecycle Test",
    status: "ACTIVE",
    passwordHash: null,
    failedLoginAttempts: 0,
    failedLoginWindowStartedAt: null,
    lockedUntil: null,
    lastLoginAt: null,
  });
  if (organizationId) {
    identity.addMembership(userId, {
      organizationId,
      name: "Lifecycle Organization",
      slug: "lifecycle-organization",
    });
  }
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
  return { identity, secret, userId };
}

function testAuthorization(
  organizationId: string,
  allow: boolean,
): AuthorizationService {
  const withPermission = async <T>(
    context: AuthorizationContext | null,
    _permissionKey: string,
    _metadata: AuthorizationMetadata,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>> => {
    if (!context) return { allowed: false, statusCode: 401, dataScopes: [] };
    if (!allow || context.organizationId !== organizationId) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }
    const resolved = {
      ...context,
      organizationId,
      membershipId: context.membershipId ?? crypto.randomUUID(),
      branch: null,
      branchAccessMode: "ALL" as const,
      roles: [],
      platformRoles: [],
      permissions: [],
    };
    return {
      allowed: true,
      value: await operation({} as OrganizationTransaction, resolved),
      context: resolved,
    };
  };
  return { withPermission } as unknown as AuthorizationService;
}

function testLifecycleService(
  overrides: Partial<LifecycleMutationService> = {},
): LifecycleMutationService {
  const organization = {
    id: crypto.randomUUID(),
    name: "Created Organization",
    slug: "created-organization",
    industry: "Retail",
    status: "PENDING",
    deploymentType: "SAAS",
  };
  return {
    createOrganization: vi.fn(
      async () =>
        ({
          organization,
          bootstrapOwner: {
            id: crypto.randomUUID(),
            membershipId: crypto.randomUUID(),
            email: "owner@example.test",
            displayName: "Initial Owner",
          },
        }) as never,
    ),
    activateOrganization: vi.fn(
      async () => ({ ...organization, status: "ACTIVE" }) as never,
    ),
    createUser: vi.fn(
      async (_transaction, organizationId, _actorId, _metadata, input) => ({
        id: crypto.randomUUID(),
        organizationId,
        email: input.email,
        displayName: input.displayName,
      }),
    ),
    inviteUser: vi.fn(
      async (_transaction, _organizationId, _actorId, _metadata, input) => ({
        id: crypto.randomUUID(),
        membershipId: crypto.randomUUID(),
        email: input.email,
        displayName: input.displayName,
      }),
    ),
    ...overrides,
  } as unknown as LifecycleMutationService;
}

describe("lifecycle API routes", () => {
  it("requires a validated session and superadmin service decision for organization creation", async () => {
    const { identity, secret, userId } = authenticatedIdentity();
    const lifecycle = testLifecycleService({
      createOrganization: vi.fn(async () => {
        throw new LifecycleMutationError("LIFECYCLE_UNAUTHORIZED");
      }),
    });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      undefined,
      { lifecycleMutations: lifecycle },
    );
    const payload = {
      name: "New Organization",
      slug: "new-organization",
      industry: "Retail",
      deploymentType: "SAAS",
      bootstrapOwner: {
        email: "owner@example.test",
        displayName: "Initial Owner",
        password: "initial-owner-password-with-16-chars",
      },
    };
    const anonymous = await app.inject({
      method: "POST",
      url: "/platform/organizations",
      headers: { "content-type": "application/json" },
      payload,
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/platform/organizations",
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: { ...payload, slug: "Invalid Organization Slug" },
    });
    const missingOwner = await app.inject({
      method: "POST",
      url: "/platform/organizations",
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: {
        name: payload.name,
        slug: payload.slug,
        industry: payload.industry,
        deploymentType: payload.deploymentType,
      },
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/platform/organizations",
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(anonymous.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(missingOwner.statusCode).toBe(400);
    expect(unauthorized.statusCode).toBe(403);
    const existingOwnerByEmail = await app.inject({
      method: "POST",
      url: "/platform/organizations",
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: {
        name: payload.name,
        slug: payload.slug,
        industry: payload.industry,
        deploymentType: payload.deploymentType,
        bootstrapOwner: { email: "owner@example.test" },
      },
    });
    expect(existingOwnerByEmail.statusCode).toBe(403);
    expect(lifecycle.createOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrapOwner: expect.objectContaining({
          email: "owner@example.test",
          displayName: "Initial Owner",
        }),
      }),
      expect.objectContaining({ userId }),
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    await app.close();
  });

  it("creates an organization with an explicit active bootstrap owner", async () => {
    const { identity, secret } = authenticatedIdentity();
    const lifecycle = testLifecycleService();
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      undefined,
      { lifecycleMutations: lifecycle },
    );
    const response = await app.inject({
      method: "POST",
      url: "/platform/organizations",
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: {
        name: "New Organization",
        slug: "new-organization",
        industry: "Retail",
        deploymentType: "SAAS",
        bootstrapOwner: {
          email: "OWNER@example.test",
          displayName: "Initial Owner",
          password: "initial-owner-password-with-16-chars",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      organization: { status: "PENDING" },
      bootstrapOwner: {
        email: "owner@example.test",
        displayName: "Initial Owner",
        status: "ACTIVE",
        role: "Organization Owner",
      },
    });
    expect(lifecycle.createOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrapOwner: {
          email: "owner@example.test",
          displayName: "Initial Owner",
          passwordHash: expect.stringMatching(/^\$argon2id\$/),
        },
      }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(response.body).not.toContain("initial-owner-password-with-16-chars");
    expect(response.body).not.toContain("$argon2id$");
    await app.close();
  });

  it("requires authentication for organization activation and rejects invalid transitions", async () => {
    const organizationId = crypto.randomUUID();
    const { identity, secret } = authenticatedIdentity();
    const activateOrganization = vi.fn(async () => {
      throw new LifecycleMutationError("INVALID_ORGANIZATION_STATE_TRANSITION");
    });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      undefined,
      {
        lifecycleMutations: testLifecycleService({
          activateOrganization: activateOrganization as never,
        }),
      },
    );

    const anonymous = await app.inject({
      method: "POST",
      url: `/platform/organizations/${organizationId}/activate`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    const invalidTransition = await app.inject({
      method: "POST",
      url: `/platform/organizations/${organizationId}/activate`,
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(anonymous.statusCode).toBe(401);
    expect(invalidTransition.statusCode).toBe(409);
    expect(activateOrganization).toHaveBeenCalledOnce();
    await app.close();
  });

  it("hashes new-user passwords and never returns the submitted secret", async () => {
    const organizationId = crypto.randomUUID();
    const { identity, secret } = authenticatedIdentity(organizationId);
    const createUser = vi.fn(
      async (...args: Parameters<LifecycleMutationService["createUser"]>) => {
        const input = args[4] as { email: string; displayName: string };
        return {
          id: crypto.randomUUID(),
          organizationId: args[1],
          email: input.email,
          displayName: input.displayName,
        };
      },
    );
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      testAuthorization(organizationId, true),
      { lifecycleMutations: testLifecycleService({ createUser }) },
    );
    const password = "test-password-with-sufficient-length";
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/users`,
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: {
        email: "NEW-USER@example.test",
        displayName: "New User",
        password,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createUser).toHaveBeenCalledWith(
      expect.any(Object),
      organizationId,
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        email: "new-user@example.test",
        passwordHash: expect.any(String),
      }),
    );
    expect(response.body).not.toContain(password);
    expect(JSON.stringify(createUser.mock.calls[0]?.[4])).not.toContain(
      password,
    );
    await app.close();
  });

  it("rejects unauthenticated, invalid, and cross-tenant user creation requests", async () => {
    const organizationId = crypto.randomUUID();
    const otherOrganizationId = crypto.randomUUID();
    const { identity, secret } = authenticatedIdentity(organizationId);
    const createUser = vi.fn();
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      testAuthorization(organizationId, true),
      {
        lifecycleMutations: testLifecycleService({
          createUser: createUser as never,
        }),
      },
    );
    const validPayload = {
      email: "new-user@example.test",
      displayName: "New User",
      password: "test-password-with-sufficient-length",
    };

    const anonymous = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/users`,
      headers: { "content-type": "application/json" },
      payload: validPayload,
    });
    const invalid = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/users`,
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: { ...validPayload, email: "not-an-email" },
    });
    const crossTenant = await app.inject({
      method: "POST",
      url: `/organizations/${otherOrganizationId}/users`,
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: validPayload,
    });

    expect(anonymous.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(crossTenant.statusCode).toBe(404);
    expect(createUser).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects user creation without the organization user-create permission", async () => {
    const organizationId = crypto.randomUUID();
    const { identity, secret } = authenticatedIdentity(organizationId);
    const createUser = vi.fn();
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      testAuthorization(organizationId, false),
      {
        lifecycleMutations: testLifecycleService({
          createUser: createUser as never,
        }),
      },
    );
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/users`,
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: {
        email: "unauthorized@example.test",
        displayName: "Unauthorized User",
        password: "test-password-with-sufficient-length",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires the existing organization user-create permission for invitations", async () => {
    const organizationId = crypto.randomUUID();
    const { identity, secret } = authenticatedIdentity(organizationId);
    const invite = vi.fn();
    const lifecycle = testLifecycleService({ inviteUser: invite as never });
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      testAuthorization(organizationId, false),
      { lifecycleMutations: lifecycle },
    );
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invitations`,
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: { email: "invite@example.test", displayName: "Invite User" },
    });

    expect(response.statusCode).toBe(403);
    expect(invite).not.toHaveBeenCalled();
    await app.close();
  });

  it("persists authorized invitations without claiming a delivery was sent", async () => {
    const organizationId = crypto.randomUUID();
    const { identity, secret } = authenticatedIdentity(organizationId);
    const invite = vi.fn(async () => ({
      id: crypto.randomUUID(),
      membershipId: crypto.randomUUID(),
      email: "invite@example.test",
      displayName: "Invite User",
    }));
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      identity,
      testAuthorization(organizationId, true),
      { lifecycleMutations: testLifecycleService({ inviteUser: invite }) },
    );
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${organizationId}/invitations`,
      cookies: { onecore_session: secret },
      headers: { "content-type": "application/json" },
      payload: { email: "invite@example.test", displayName: "Invite User" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().invitation).toMatchObject({
      email: "invite@example.test",
      status: "INVITED",
      delivery: "NOT_CONFIGURED",
    });
    expect(invite).toHaveBeenCalledOnce();
    await app.close();
  });
});
