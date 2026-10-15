import { createHash } from "node:crypto";
import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import { loadConfig } from "@onecore/config";
import type { IdentityUser, RateLimiter } from "@onecore/database";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  requireAuthenticated,
  requireOrganizationMembership,
} from "../src/authentication.js";
import {
  decryptSecret,
  encryptSecret,
  generateTotpCode,
  generateTotpSecret,
  verifyTotp,
} from "../src/identity-security.js";
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
  rateLimiter?: RateLimiter,
  mfaEnforcement: "required" | "disabled" = "required",
) {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    AUTH_LOGIN_RATE_LIMIT_MAX: String(rateLimitMax),
    AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: "60000",
    AUTH_MFA_ENFORCEMENT: mfaEnforcement,
    MFA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  });
  const app = buildApp(
    config,
    identity,
    undefined,
    rateLimiter ? { rateLimiter } : {},
  );
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

  it("blocks a previously unverified session if the user is later granted a privileged role", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    const { app } = createTestApp(identity);
    const authenticated = await login(app);
    expect(authenticated.statusCode).toBe(200);
    expect(identity.sessions.size).toBe(1);

    identity.addPlatformRole(user.id, "SUPERADMIN");
    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: cookieFrom(authenticated) },
    });

    expect(session.statusCode).toBe(401);
    expect(session.headers["set-cookie"]).toContain("onecore_session=");
    await app.close();
  });

  it("rejects an expired MFA enrollment secret", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    await identity.storeMfaSecret(
      user.id,
      encryptSecret(generateTotpSecret(), "0123456789abcdef0123456789abcdef"),
      new Date(Date.now() - 1_000),
    );
    const { app } = createTestApp(identity);
    const response = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: {
        email: user.email,
        password,
        code: "123456",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("expired");
    expect(identity.sessions.size).toBe(0);
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
    identity.addPlatformRole(userId, "SUPERADMIN");
    const { app } = createTestApp(identity, 100, undefined, "disabled");

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
    const app = buildApp(config, identity, undefined, {
      rateLimiter: {
        consume: async () => ({
          allowed: true,
          remaining: 4,
          resetAt: new Date(Date.now() + 60_000),
        }),
      },
    });

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
      mfaVerifiedAt: null,
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

  it("changes credentials atomically, revokes every session, and audits without secrets", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const { app } = createTestApp(identity);
    const firstCookie = cookieFrom(await login(app));
    const secondCookie = cookieFrom(await login(app));

    const changed = await app.inject({
      method: "POST",
      url: "/auth/password/change",
      headers: { cookie: secondCookie, "content-type": "application/json" },
      payload: {
        currentPassword: password,
        newPassword: "An-Entirely-New-Password-42!",
      },
    });

    expect(changed.statusCode).toBe(204);
    expect(changed.headers["set-cookie"]).toContain("Max-Age=0");
    expect(
      [...identity.sessions.values()].every((session) => session.revokedAt),
    ).toBe(true);
    for (const cookie of [firstCookie, secondCookie]) {
      const stale = await app.inject({
        method: "GET",
        url: "/auth/session",
        headers: { cookie },
      });
      expect(stale.statusCode).toBe(401);
    }

    expect((await login(app)).statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: {
        email: "owner@example.test",
        password: "An-Entirely-New-Password-42!",
      },
    });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.body).not.toContain(
      identity.users.get("owner@example.test")?.passwordHash,
    );

    const securityEvents = identity.events.filter((event) =>
      ["AUTH_PASSWORD_CHANGED", "AUTH_SESSIONS_REVOKED"].includes(event.action),
    );
    expect(securityEvents.map((event) => event.action)).toEqual([
      "AUTH_PASSWORD_CHANGED",
      "AUTH_SESSIONS_REVOKED",
    ]);
    const serializedEvents = JSON.stringify(securityEvents);
    expect(serializedEvents).not.toContain(password);
    expect(serializedEvents).not.toContain("An-Entirely-New-Password-42!");
    expect(serializedEvents).not.toContain(firstCookie);
    expect(serializedEvents).not.toContain(secondCookie);
    await app.close();
  });

  it("rejects incorrect and weak password changes without revoking the session", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const { app } = createTestApp(identity);
    const cookie = cookieFrom(await login(app));

    const incorrect = await app.inject({
      method: "POST",
      url: "/auth/password/change",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        currentPassword: "incorrect-current-password",
        newPassword: "An-Entirely-New-Password-42!",
      },
    });
    expect(incorrect.statusCode).toBe(403);
    expect(identity.events.at(-1)?.action).toBe("AUTH_PASSWORD_CHANGE_FAILURE");

    const weak = await app.inject({
      method: "POST",
      url: "/auth/password/change",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        currentPassword: password,
        newPassword: "short",
      },
    });
    expect(weak.statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/auth/session",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it.each(["required", "disabled"] as const)(
    "enforces login rate limits and same-origin JSON mutation requests with MFA %s",
    async (mfaEnforcement) => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
      const { app } = createTestApp(identity, 2, undefined, mfaEnforcement);
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
    },
  );

  it.each(["required", "disabled"] as const)(
    "fails closed when the shared login rate limiter is unavailable with MFA %s",
    async (mfaEnforcement) => {
      const identity = new MemoryIdentityRepository();
      identity.addUser(testUser());
      const missingLimiterRelation = Object.assign(
        new Error('relation "rate_limit_buckets" does not exist'),
        { code: "42P01", table_name: "rate_limit_buckets" },
      );
      const { app } = createTestApp(
        identity,
        100,
        {
          consume: async () => {
            throw missingLimiterRelation;
          },
        },
        mfaEnforcement,
      );

      const response = await login(app);

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("SERVICE_UNAVAILABLE");
      expect(identity.sessions.size).toBe(0);
      expect(identity.events).toHaveLength(0);
      expect(response.body).not.toContain("rate_limit_buckets");
      await app.close();
    },
  );

  it.each([
    "SUPERADMIN",
    "SUPPORT",
    "Organization Owner",
    "Organization Admin",
  ] as const)(
    "requires TOTP before issuing a %s session",
    async (role) => {
      const identity = new MemoryIdentityRepository();
      const user = testUser();
      if (role === "SUPERADMIN" || role === "SUPPORT") {
        identity.addPlatformRole(user.id, role);
      } else {
        identity.addMembership(user.id, {
          organizationId: orgA,
          name: "Demo Organization",
          slug: "demo",
        });
        identity.addOrganizationRole(user.id, orgA, role);
      }
      identity.addUser(user);
      const { app } = createTestApp(identity, 100, undefined, "required");

      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "content-type": "application/json" },
        payload: { email: "owner@example.test", password },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("MFA_REQUIRED");
      expect(response.json().mfa.status).toBe("enrollment_required");
      expect(identity.sessions.size).toBe(0);
      expect(response.headers["set-cookie"]).toBeUndefined();
      await app.close();
    },
  );

  it.each([
    "SUPERADMIN",
    "SUPPORT",
    "Organization Owner",
    "Organization Admin",
    "MEMBER",
  ] as const)(
    "allows password-only login and session bootstrap for %s when MFA enforcement is disabled",
    async (role) => {
      const identity = new MemoryIdentityRepository();
      const user = testUser();
      if (role === "SUPERADMIN" || role === "SUPPORT") {
        identity.addPlatformRole(user.id, role);
      } else {
        identity.addMembership(user.id, {
          organizationId: orgA,
          name: "Demo Organization",
          slug: "demo",
        });
        if (role !== "MEMBER") {
          identity.addOrganizationRole(user.id, orgA, role);
        }
      }
      identity.addUser(user);
      const { app } = createTestApp(identity, 100, undefined, "disabled");

      const response = await login(app);
      expect(response.statusCode).toBe(200);
      expect(await identity.userRequiresMfa(user.id)).toBe(role !== "MEMBER");
      expect(response.json()).not.toHaveProperty("mfa");
      expect(response.headers["set-cookie"]).toContain("onecore_session=");

      const cookie = cookieFrom(response);
      const session = await app.inject({
        method: "GET",
        url: "/auth/session",
        headers: { cookie },
      });
      expect(session.statusCode).toBe(200);
      expect(identity.sessions.size).toBe(1);

      const logout = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { cookie, "content-type": "application/json" },
        payload: {},
      });
      expect(logout.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/auth/session",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
      await app.close();
    },
  );

  it("rejects wrong passwords and unknown users when MFA enforcement is disabled", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addPlatformRole(user.id, "SUPERADMIN");
    identity.addUser(user);
    const { app } = createTestApp(identity, 100, undefined, "disabled");

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: user.email, password: "incorrect" },
    });
    const unknownUser = await login(app, "missing@example.test");

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(unknownUser.body).toBe(wrongPassword.body);
    expect(identity.sessions.size).toBe(0);
    await app.close();
  });

  it("accepts a valid TOTP challenge and stores encrypted secrets", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const { app } = createTestApp(identity);

    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, "0123456789abcdef0123456789abcdef");
    const now = new Date();
    await identity.storeMfaSecret(
      user.id,
      encrypted,
      new Date(now.getTime() + 10 * 60_000),
    );
    await identity.completeMfaEnrollment(
      user.id,
      Math.floor(Date.now() / 30_000) - 1,
      {
        action: "AUTH_MFA_ENROLLED",
        actorUserId: user.id,
        result: "SUCCESS",
        requestId: "test-enrollment",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        occurredAt: now,
      },
    );

    const code = generateTotpCode(secret);
    const valid = await app.inject({
      method: "POST",
      url: "/auth/mfa/challenge",
      headers: { "content-type": "application/json" },
      payload: {
        email: "owner@example.test",
        password,
        code,
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().user.email).toBe("owner@example.test");
    expect(valid.headers["set-cookie"]).toContain("onecore_session=");
    expect(valid.body).not.toContain(encrypted);
    expect(valid.body).not.toContain(secret);
    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: cookieFrom(valid) },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().memberships).toEqual([]);
    const decrypted = decryptSecret(
      encrypted,
      "0123456789abcdef0123456789abcdef",
    );
    expect(decrypted).toBe(secret);
    await app.close();
  });

  it("rejects reuse of a TOTP time step", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, "0123456789abcdef0123456789abcdef");
    const now = new Date();
    await identity.storeMfaSecret(
      user.id,
      encrypted,
      new Date(now.getTime() + 10 * 60_000),
    );
    await identity.completeMfaEnrollment(
      user.id,
      Math.floor(Date.now() / 30_000) - 1,
      {
        action: "AUTH_MFA_ENROLLED",
        actorUserId: user.id,
        result: "SUCCESS",
        requestId: "test-enrollment",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        occurredAt: now,
      },
    );
    const { app } = createTestApp(identity);
    const request = () =>
      app.inject({
        method: "POST",
        url: "/auth/mfa/challenge",
        headers: { "content-type": "application/json" },
        payload: {
          email: user.email,
          password,
          code: generateTotpCode(secret),
        },
      });

    expect((await request()).statusCode).toBe(200);
    const replay = await request();
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.message).toBe("The MFA code is invalid.");
    expect(identity.sessions.size).toBe(1);
    await app.close();
  });

  it("keeps MFA enrollment pending until a valid code is verified", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const { app } = createTestApp(identity);
    const start = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: { email: user.email, password },
    });

    expect(start.statusCode).toBe(200);
    expect(start.headers["set-cookie"]).toBeUndefined();
    expect(identity.sessions.size).toBe(0);
    const provisioningUri = start.json().mfa.provisioningUri as string;
    const secret = new URL(provisioningUri).searchParams.get("secret");
    expect(secret).toBeTruthy();
    const pending = await identity.getMfaCredential(user.id);
    expect(pending?.enabledAt).toBeNull();
    expect(pending?.secretEncrypted).not.toBe(secret);

    const invalid = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: { email: user.email, password, code: "abcdef" },
    });
    expect(invalid.statusCode).toBe(401);
    expect((await identity.getMfaCredential(user.id))?.enabledAt).toBeNull();
    expect(identity.sessions.size).toBe(0);

    const verified = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: {
        email: user.email,
        password,
        code: generateTotpCode(secret ?? ""),
      },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.headers["set-cookie"]).toContain("onecore_session=");
    expect(
      (await identity.getMfaCredential(user.id))?.enabledAt,
    ).toBeInstanceOf(Date);
    expect(identity.sessions.size).toBe(1);
    await app.close();
  });

  it("rate limits unauthenticated MFA enrollment by IP and account", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const hits = new Map<string, number>();
    const consumedSubjects: string[] = [];
    const rateLimiter: RateLimiter = {
      async consume({ scope, subject }) {
        const key = `${scope}:${subject}`;
        const hitCount = (hits.get(key) ?? 0) + 1;
        hits.set(key, hitCount);
        consumedSubjects.push(subject);
        const limited = subject.startsWith("account:") && hitCount > 1;
        return {
          allowed: !limited,
          remaining: limited ? 0 : 99,
          resetAt: new Date(Date.now() + 60_000),
        };
      },
    };
    const { app } = createTestApp(identity, 100, rateLimiter);
    const request = (email = user.email) =>
      app.inject({
        method: "POST",
        url: "/auth/mfa/enroll",
        headers: { "content-type": "application/json" },
        payload: { email, password },
      });

    expect((await request()).statusCode).toBe(200);
    const limited = await request(user.email.toUpperCase());
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("TOO_MANY_REQUESTS");
    expect(consumedSubjects).toContain("127.0.0.1");
    expect(
      consumedSubjects.some((subject) => subject.startsWith("account:")),
    ).toBe(true);
    expect(consumedSubjects.join(" ")).not.toContain(user.email);
    expect(identity.sessions.size).toBe(0);
    await app.close();
  });

  it("records failed enrollment passwords and locks the account at the login threshold", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const { app } = createTestApp(identity);
    const request = () =>
      app.inject({
        method: "POST",
        url: "/auth/mfa/enroll",
        headers: { "content-type": "application/json" },
        payload: {
          email: user.email,
          password: "incorrect synthetic password",
        },
      });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request()).statusCode).toBe(401);
    }
    expect((await identity.findUserById(user.id))?.status).toBe("LOCKED");
    expect(
      identity.events.filter((event) => event.action === "AUTH_LOGIN_FAILURE"),
    ).toHaveLength(10);
    expect(
      identity.events.filter((event) => event.action === "AUTH_ACCOUNT_LOCKED"),
    ).toHaveLength(1);
    expect(identity.sessions.size).toBe(0);

    const stillLocked = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: { email: user.email, password },
    });
    expect(stillLocked.statusCode).toBe(401);
    expect(stillLocked.json().error.message).toBe(
      "Email or password is incorrect.",
    );
    expect((await identity.findUserById(user.id))?.status).toBe("LOCKED");

    const expiredLock = await identity.findUserById(user.id);
    if (!expiredLock) throw new Error("Synthetic locked user was not found");
    expiredLock.lockedUntil = new Date(Date.now() - 1_000);
    identity.addUser(expiredLock);
    const unlockedLogin = await login(app);
    expect(unlockedLogin.statusCode).toBe(403);
    expect(unlockedLogin.json().error.code).toBe("MFA_REQUIRED");
    expect((await identity.findUserById(user.id))?.status).toBe("ACTIVE");
    expect((await identity.findUserById(user.id))?.failedLoginAttempts).toBe(0);

    const enrollmentAfterUnlock = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: { email: user.email, password },
    });
    expect(enrollmentAfterUnlock.statusCode).toBe(200);
    await app.close();
  });

  it("fails closed when the shared limiter is unavailable in production", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const config = loadConfig({
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      AUTH_ALLOWED_ORIGINS: "https://business.example.test",
      MFA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    });
    const app = buildApp(config, identity);
    const request = () =>
      app.inject({
        method: "POST",
        url: "/auth/mfa/enroll",
        headers: {
          "content-type": "application/json",
          origin: "https://business.example.test",
        },
        payload: { email: user.email, password },
      });

    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("SERVICE_UNAVAILABLE");
    expect(response.body).not.toContain("provisioningUri");
    expect(identity.sessions.size).toBe(0);
    await app.close();
  });

  it("does not verify credentials when the shared limiter store throws", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const config = loadConfig({
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      AUTH_ALLOWED_ORIGINS: "https://business.example.test",
      MFA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    });
    const rateLimiter: RateLimiter = {
      consume: async () => {
        throw new Error("synthetic shared limiter store failure");
      },
    };
    const app = buildApp(config, identity, undefined, { rateLimiter });
    const response = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: {
        "content-type": "application/json",
        origin: "https://business.example.test",
      },
      payload: { email: user.email, password },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    });
    expect(response.body).not.toContain(
      "synthetic shared limiter store failure",
    );
    expect(response.body).not.toContain("provisioningUri");
    expect(identity.sessions.size).toBe(0);
    await app.close();
  });

  it("ignores client-supplied roles when deciding whether MFA is mandatory", async () => {
    const identity = new MemoryIdentityRepository();
    identity.addUser(testUser());
    const { app } = createTestApp(identity);
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: {
        email: "owner@example.test",
        password,
        role: "SUPERADMIN",
        platformRoles: ["SUPERADMIN"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(identity.sessions.size).toBe(1);
    await app.close();
  });

  it("rate limits invalid TOTP challenge attempts", async () => {
    const identity = new MemoryIdentityRepository();
    const user = testUser();
    identity.addUser(user);
    identity.addPlatformRole(user.id, "SUPERADMIN");
    const secret = generateTotpSecret();
    const now = new Date();
    await identity.storeMfaSecret(
      user.id,
      encryptSecret(secret, "0123456789abcdef0123456789abcdef"),
      new Date(now.getTime() + 10 * 60_000),
    );
    await identity.completeMfaEnrollment(
      user.id,
      Math.floor(Date.now() / 30_000) - 1,
      {
        action: "AUTH_MFA_ENROLLED",
        actorUserId: user.id,
        result: "SUCCESS",
        requestId: "test-enrollment",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        occurredAt: now,
      },
    );
    const { app } = createTestApp(identity, 2);
    const request = () =>
      app.inject({
        method: "POST",
        url: "/auth/mfa/challenge",
        headers: { "content-type": "application/json" },
        payload: { email: user.email, password, code: "abcdef" },
      });

    expect((await request()).statusCode).toBe(401);
    expect((await request()).statusCode).toBe(401);
    const limited = await request();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("TOO_MANY_REQUESTS");
    expect(identity.sessions.size).toBe(0);
    await app.close();
  });

  it("verifies correct TOTP values and rejects incorrect codes", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = generateTotpCode(secret, now);

    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, "abcdef", now)).toBe(false);
    expect(
      verifyTotp(secret, generateTotpCode(secret, now - 60_000), now),
    ).toBe(false);
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
