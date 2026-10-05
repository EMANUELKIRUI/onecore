import { createHash } from "node:crypto";
import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import { loadConfig } from "@onecore/config";
import type { IdentityUser } from "@onecore/database";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  requireAuthenticated,
  requireOrganizationMembership,
} from "../src/authentication.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";

const userId = "fc4109a0-7e91-4194-a202-42c42da28c71";
const orgA = "dc3bb93f-98f0-4156-98a5-50889a771203";
const orgB = "e132e8a9-2f15-4d43-a2af-e674e8dc5601";
const orgC = "be9ad44a-abcb-4a6f-8ff8-4f3baeb34d5c";
const password = "Correct-Horse-Battery-123!";
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 8_192,
    timeCost: 1,
    parallelism: 1,
  });
});

function testUser(status: IdentityUser["status"] = "ACTIVE"): IdentityUser {
  return {
    id: userId,
    email: "owner@example.test",
    displayName: "Demo Organization Owner",
    status,
    passwordHash,
    failedLoginAttempts: 0,
    failedLoginWindowStartedAt: null,
    lockedUntil: null,
    lastLoginAt: null,
  };
}

function createTestApp(
  identity = new MemoryIdentityRepository(),
  rateLimitMax = 100,
) {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    AUTH_LOGIN_RATE_LIMIT_MAX: String(rateLimitMax),
    AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: "60000",
  });
  const app = buildApp(config, identity);
  return { app, identity };
}

async function login(
  app: ReturnType<typeof buildApp>,
  email = "owner@example.test",
) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "content-type": "application/json" },
    payload: { email, password },
  });
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  const values = Array.isArray(value) ? value : [value];
  const cookie = values.find(
    (header): header is string =>
      typeof header === "string" &&
      /^onecore_session=[A-Za-z0-9_-]{43};/.test(header),
  );
  if (!cookie) throw new Error("Session cookie was not set");
  return cookie.split(";")[0] ?? "";
}

function cookieSecret(cookie: string): string {
  return cookie.slice("onecore_session=".length);
}

describe("identity and authentication API", () => {
  it("rejects anonymous requests at protected endpoints", async () => {
    const { app } = createTestApp();
    const response = await app.inject({ method: "GET", url: "/auth/session" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("authenticates safely and resolves a server-side cookie session", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const { app } = createTestApp(identity);

    const response = await login(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      user: {
        id: userId,
        email: "owner@example.test",
        displayName: "Demo Organization Owner",
      },
      session: { expiresAt: expect.any(String) },
    });
    const cookie = cookieFrom(response);
    expect(cookieSecret(cookie)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.body).not.toContain(password);
    expect(response.body).not.toContain(passwordHash);
    expect(response.body).not.toContain(cookieSecret(cookie));

    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user).toEqual({
      id: userId,
      email: "owner@example.test",
      displayName: "Demo Organization Owner",
    });
    expect(session.json().memberships).toEqual([]);
    expect(session.body).not.toContain(passwordHash);
    expect(identity.events.map((event) => event.action)).toContain(
      "AUTH_LOGIN_SUCCESS",
    );
    await app.close();
  });

  it("returns the same public response for unknown emails and wrong passwords", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const { app } = createTestApp(identity);
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "owner@example.test", password: "incorrect" },
    });
    const unknownUser = await login(app, "missing@example.test");

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(unknownUser.body).toBe(wrongPassword.body);
    expect(unknownUser.json().error.message).toBe(
      "Email or password is incorrect.",
    );
    expect(
      identity.events.filter((event) => event.action === "AUTH_LOGIN_FAILURE"),
    ).toHaveLength(2);
    await app.close();
  });

  it("rejects accounts outside the ACTIVE lifecycle and locks after repeated failures", async () => {
    const identity = new MemoryIdentityRepository();
    const statuses: IdentityUser["status"][] = [
      "PENDING",
      "SUSPENDED",
      "LOCKED",
      "DISABLED",
    ];
    statuses.forEach((status, index) => {
      const user = testUser(status);
      user.id = `fc4109a0-7e91-4194-a202-42c42da28c7${index}`;
      user.email = `status-${index}@example.test`;
      identity.addUser(user);
    });
    identity.addUser(testUser());
    const { app } = createTestApp(identity, 100);

    for (let index = 0; index < statuses.length; index += 1) {
      const response = await login(app, `status-${index}@example.test`);
      expect(response.statusCode).toBe(401);
    }

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "content-type": "application/json" },
        payload: { email: "owner@example.test", password: "incorrect" },
      });
      expect(response.statusCode).toBe(401);
    }
    expect((await identity.findUserByEmail("owner@example.test"))?.status).toBe(
      "LOCKED",
    );
    expect(identity.events.map((event) => event.action)).toContain(
      "AUTH_ACCOUNT_LOCKED",
    );
    await app.close();
  });

  it("automatically unlocks only an expired timed lock and sets Secure in production", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser("LOCKED");
    user.lockedUntil = new Date(Date.now() - 1_000);
    user.failedLoginAttempts = 10;
    identity.addUser(user);
    const config = loadConfig({
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      AUTH_ALLOWED_ORIGINS: "https://business.example",
    });
    const app = buildApp(config, identity);

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: {
        "content-type": "application/json",
        origin: "https://business.example",
      },
      payload: { email: "OWNER@example.test", password },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(identity.events.map((event) => event.action)).toContain(
      "AUTH_ACCOUNT_UNLOCKED",
    );
    await app.close();
  });

  it("selects only active memberships and ignores client branch and organization headers", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    identity.addMembership(userId, {
      organizationId: orgA,
      name: "Demo Retail Ltd",
      slug: "demo-retail",
      branchAccessMode: "ASSIGNED",
    });
    identity.addMembership(userId, {
      organizationId: orgB,
      name: "Demo Hotel Ltd",
      slug: "demo-hotel",
      branchAccessMode: "ALL",
    });
    const branchA = {
      branchId: "6e7b6087-6be7-43ce-b7a2-6a3fb2e745e9",
      name: "Retail Main",
      code: "RTL-MAIN",
    };
    const branchB = {
      branchId: "e267bd49-aec1-446c-a165-8f7b769c7eb4",
      name: "Hotel Main",
      code: "HTL-MAIN",
    };
    identity.addBranchAccess(userId, orgA, branchA);
    identity.addOrganizationBranch(orgB, branchB);
    identity.addBranchAccess(
      userId,
      orgA,
      { branchId: orgC, name: "Closed Branch", code: "CLOSED" },
      false,
    );
    const { app } = createTestApp(identity);
    app.get(
      "/test-auth-context",
      {
        preHandler: [requireAuthenticated(), requireOrganizationMembership()],
      },
      async (request) => request.auth,
    );
    const loginResponse = await login(app);
    const cookie = cookieFrom(loginResponse);

    const rejected = await app.inject({
      method: "POST",
      url: "/auth/organization",
      headers: { cookie, "content-type": "application/json" },
      payload: { organizationId: orgC },
    });
    expect(rejected.statusCode).toBe(403);

    const selected = await app.inject({
      method: "POST",
      url: "/auth/organization",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        organizationId: orgA,
        branchId: "17ec9069-fbbf-4d2c-8e16-cc6dbca5c9f2",
      },
    });
    expect(selected.statusCode).toBe(200);

    const context = await app.inject({
      method: "GET",
      url: "/test-auth-context",
      headers: { cookie, "x-organization-id": orgB },
    });
    expect(context.json()).toEqual({
      userId,
      sessionId: expect.any(String),
      sessionExpiresAt: expect.any(String),
      organizationId: orgA,
      membershipId: expect.any(String),
      branchId: null,
    });

    const unauthorizedBranch = await app.inject({
      method: "POST",
      url: "/auth/branch",
      headers: { cookie, "content-type": "application/json" },
      payload: { branchId: orgC },
    });
    expect(unauthorizedBranch.statusCode).toBe(403);
    const missingBranch = await app.inject({
      method: "POST",
      url: "/auth/branch",
      headers: { cookie, "content-type": "application/json" },
      payload: { branchId: crypto.randomUUID() },
    });
    expect(missingBranch.statusCode).toBe(403);

    const selectedBranch = await app.inject({
      method: "POST",
      url: "/auth/branch",
      headers: { cookie, "content-type": "application/json" },
      payload: { branchId: branchA.branchId },
    });
    expect(selectedBranch.statusCode).toBe(200);
    expect(selectedBranch.json().branch).toEqual(branchA);
    const selectedOrganizationSession = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(selectedOrganizationSession.json().availableBranches).toEqual([
      branchA,
    ]);

    const foreignOrganizationBranch = await app.inject({
      method: "POST",
      url: "/auth/branch",
      headers: { cookie, "content-type": "application/json" },
      payload: { branchId: branchB.branchId },
    });
    expect(foreignOrganizationBranch.statusCode).toBe(403);

    const branchContext = await app.inject({
      method: "GET",
      url: "/test-auth-context",
      headers: { cookie, "x-branch-id": branchB.branchId },
    });
    expect(branchContext.json().branchId).toBe(branchA.branchId);
    expect(identity.events.map((event) => event.action)).toContain(
      "AUTH_BRANCH_SELECTED",
    );
    identity.removeBranchAccess(userId, orgA, branchA.branchId);
    const revokedBranchContext = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(revokedBranchContext.json().branch).toBeNull();
    expect(identity.events.map((event) => event.action)).toContain(
      "AUTH_BRANCH_CONTEXT_CLEARED",
    );

    const switched = await app.inject({
      method: "POST",
      url: "/auth/organization",
      headers: { cookie, "content-type": "application/json" },
      payload: { organizationId: orgB },
    });
    expect(switched.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/auth/session",
          headers: { cookie },
        })
      ).json().organization.organizationId,
    ).toBe(orgB);
    const switchedContext = await app.inject({
      method: "GET",
      url: "/test-auth-context",
      headers: { cookie },
    });
    expect(switchedContext.json().branchId).toBeNull();
    const organizationBSession = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(organizationBSession.json().availableBranches).toEqual([branchB]);
    const organizationWideBranch = await app.inject({
      method: "POST",
      url: "/auth/branch",
      headers: { cookie, "content-type": "application/json" },
      payload: { branchId: branchB.branchId },
    });
    expect(organizationWideBranch.statusCode).toBe(200);
    expect(organizationWideBranch.json().branch).toEqual(branchB);
    identity.deactivateMembership(userId, orgB);
    const staleSession = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(staleSession.statusCode).toBe(200);
    expect(staleSession.json().organization).toBeNull();
    expect(staleSession.json().branch).toBeNull();
    expect(staleSession.json().memberships).toEqual([
      {
        organizationId: orgA,
        name: "Demo Retail Ltd",
        slug: "demo-retail",
      },
    ]);
    expect(identity.events.map((event) => event.action)).toContain(
      "AUTH_ORGANIZATION_CONTEXT_CLEARED",
    );
    await app.close();
  });

  it("requires active membership and an operational organization context", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    identity.addMembership(
      userId,
      {
        organizationId: orgA,
        name: "Inactive Membership",
        slug: "inactive-membership",
      },
      { active: false },
    );
    identity.addMembership(
      userId,
      {
        organizationId: orgB,
        name: "Suspended Organization",
        slug: "suspended-organization",
      },
      { organizationActive: false },
    );
    const { app } = createTestApp(identity);
    const cookie = cookieFrom(await login(app));

    for (const organizationId of [orgA, orgB]) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/organization",
        headers: { cookie, "content-type": "application/json" },
        payload: { organizationId },
      });
      expect(response.statusCode).toBe(403);
    }
    await app.close();
  });

  it("revokes sessions on logout and rejects session fixation and reuse", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const { app } = createTestApp(identity);
    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: {
        "content-type": "application/json",
        cookie: "onecore_session=attacker-controlled",
      },
      payload: { email: "owner@example.test", password },
    });
    const cookie = cookieFrom(loginResponse);
    expect(cookieSecret(cookie)).not.toBe("attacker-controlled");

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    expect(identity.events.map((event) => event.action)).toContain(
      "AUTH_LOGOUT",
    );
    const reused = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(reused.statusCode).toBe(401);
    await app.close();
  });

  it("enforces login rate limits and same-origin JSON mutation requests", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const { app } = createTestApp(identity, 2);
    const body = { email: "owner@example.test", password: "incorrect" };
    const request = () =>
      app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "content-type": "application/json" },
        payload: body,
      });

    expect((await request()).statusCode).toBe(401);
    expect((await request()).statusCode).toBe(401);
    const limited = await request();
    expect(limited.headers["x-ratelimit-limit"]).toBe("2");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("TOO_MANY_REQUESTS");

    const crossSite = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      payload: {},
    });
    expect(crossSite.statusCode).toBe(403);
    await app.close();
  });

  it("rejects expired cookies and does not persist plaintext passwords", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const secret = "A".repeat(43);
    const secretHash = createHash("sha256").update(secret).digest("hex");
    identity.sessions.set(secretHash, {
      id: crypto.randomUUID(),
      secretHash,
      userId,
      organizationId: null,
      branchId: null,
      expiresAt: new Date(Date.now() - 60_000),
      lastUsedAt: new Date(Date.now() - 120_000),
      revokedAt: null,
      ipAddress: null,
      userAgent: null,
    });
    const { app } = createTestApp(identity);
    const response = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: `onecore_session=${secret}` },
    });
    const storedUser = await identity.findUserByEmail("owner@example.test");

    expect(response.statusCode).toBe(401);
    expect(storedUser?.passwordHash).toBe(passwordHash);
    expect(storedUser?.passwordHash).not.toBe(password);
    await app.close();
  });
});
