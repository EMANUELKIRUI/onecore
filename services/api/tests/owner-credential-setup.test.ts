import { createHash, randomBytes } from "node:crypto";
import {
  Algorithm,
  hash as hashPassword,
  verify as verifyPassword,
} from "@node-rs/argon2";
import { loadConfig } from "@onecore/config";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { generateTotpCode } from "../src/identity-security.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";

const adminId = "ec895685-96fb-4be7-ae59-d3cf7fc2dd01";
const ownerId = "861d8b6a-e7c6-411f-9ea8-77aaf37daf46";
const organizationId = "45da1b09-514b-47a8-8117-351ef8d8d8b9";
const email = "first-owner@example.test";
const ownerPassword = "A-long-synthetic-owner-password!";

function setupIdentity() {
  const identity = new MemoryIdentityRepository();
  identity.addUser({
    id: adminId,
    email: "admin@example.test",
    displayName: "Platform Admin",
    status: "ACTIVE",
    passwordHash: null,
    failedLoginAttempts: 0,
    failedLoginWindowStartedAt: null,
    lockedUntil: null,
    lastLoginAt: null,
  });
  identity.addPlatformRole(adminId, "SUPERADMIN");
  identity.addUser({
    id: ownerId,
    email,
    displayName: "First Owner",
    status: "PENDING",
    passwordHash: null,
    failedLoginAttempts: 0,
    failedLoginWindowStartedAt: null,
    lockedUntil: null,
    lastLoginAt: null,
  });
  identity.addMembership(
    ownerId,
    {
      organizationId,
      name: "Provisioned Organization",
      slug: "provisioned-organization",
    },
    { active: false },
  );
  identity.addOrganizationRole(ownerId, organizationId, "Organization Owner");
  return identity;
}

async function authenticatedAdmin(identity: MemoryIdentityRepository) {
  const sessionSecret = randomBytes(32).toString("base64url");
  await identity.createSession(
    {
      secretHash: createHash("sha256").update(sessionSecret).digest("hex"),
      userId: adminId,
      organizationId: null,
      branchId: null,
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: "127.0.0.1",
      userAgent: "owner-setup-test",
    },
    crypto.randomUUID(),
    new Date(),
    undefined,
    true,
  );
  return `onecore_session=${sessionSecret}`;
}

function appFor(
  identity: MemoryIdentityRepository,
  transactionalEmailSender: NonNullable<
    NonNullable<Parameters<typeof buildApp>[3]>["transactionalEmailSender"]
  >,
  rateLimitMax = 20,
) {
  return buildApp(
    loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      AUTH_ALLOWED_ORIGINS: "https://admin.example.test",
      BUSINESS_APP_ORIGIN: "https://business.example.test",
      MFA_ENCRYPTION_KEY: "test-only-mfa-encryption-key-32-characters",
      RESEND_API_KEY: "re_test_only",
      RESEND_FROM_EMAIL: "no-reply@example.test",
      AUTH_LOGIN_RATE_LIMIT_MAX: String(rateLimitMax),
    }),
    identity,
    undefined,
    { transactionalEmailSender },
  );
}

function invitationToken(text: string): string {
  const link = text.match(
    /https:\/\/business\.example\.test\/setup\.html#token=([A-Za-z0-9_-]{43})/,
  )?.[1];
  if (!link) throw new Error("Mock email did not contain a setup link");
  return link;
}

describe("first Owner credential setup", () => {
  it("retries safely, atomically consumes the token, hashes the password, and still requires MFA", async () => {
    const identity = setupIdentity();
    const mailer = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false,
        status: "FAILED",
        provider: "resend",
      })
      .mockResolvedValueOnce({
        accepted: true,
        status: "QUEUED",
        provider: "resend",
        messageId: "mock-message-id",
      });
    const app = appFor(identity, mailer);
    const cookie = await authenticatedAdmin(identity);
    const invitationRequest = () =>
      app.inject({
        method: "POST",
        url: `/platform/organization-applications/${organizationId}/owner-invitation`,
        headers: {
          cookie,
          origin: "https://admin.example.test",
          "content-type": "application/json",
        },
        payload: {},
      });

    const rejected = await invitationRequest();
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().invitation.status).toBe("FAILED");
    const rejectedToken = invitationToken(
      mailer.mock.calls[0]?.[0]?.text ?? "",
    );

    const accepted = await invitationRequest();
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().invitation.status).toBe("QUEUED");
    expect(JSON.stringify(accepted.json())).not.toMatch(/[A-Za-z0-9_-]{43}/);
    const acceptedToken = invitationToken(
      mailer.mock.calls[1]?.[0]?.text ?? "",
    );
    expect(acceptedToken).not.toBe(rejectedToken);

    const staleLink = await app.inject({
      method: "POST",
      url: "/auth/owner-credential-setup",
      headers: {
        origin: "https://admin.example.test",
        "content-type": "application/json",
      },
      payload: { token: rejectedToken, password: ownerPassword },
    });
    expect(staleLink.statusCode).toBe(400);

    const setup = await app.inject({
      method: "POST",
      url: "/auth/owner-credential-setup",
      headers: {
        origin: "https://admin.example.test",
        "content-type": "application/json",
      },
      payload: { token: acceptedToken, password: ownerPassword },
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().nextStep).toBe("SIGN_IN_AND_ENROLL_MFA");
    expect(setup.headers["set-cookie"]).toBeUndefined();
    const owner = await identity.findUserById(ownerId);
    expect(owner?.status).toBe("ACTIVE");
    expect(owner?.passwordHash).not.toBe(ownerPassword);
    expect(await verifyPassword(owner?.passwordHash ?? "", ownerPassword)).toBe(
      true,
    );
    expect(identity.sessions.size).toBe(1);

    const replay = await app.inject({
      method: "POST",
      url: "/auth/owner-credential-setup",
      headers: {
        origin: "https://admin.example.test",
        "content-type": "application/json",
      },
      payload: { token: acceptedToken, password: ownerPassword },
    });
    expect(replay.statusCode).toBe(400);
    expect(identity.sessions.size).toBe(1);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: ownerPassword },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().mfa.status).toBe("enrollment_required");
    expect(login.headers["set-cookie"]).toBeUndefined();

    const enrollment = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: { email, password: ownerPassword },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.headers["set-cookie"]).toBeUndefined();
    const secret = new URL(
      enrollment.json().mfa.provisioningUri,
    ).searchParams.get("secret");
    expect(secret).toBeTruthy();
    const verifyEnrollment = await app.inject({
      method: "POST",
      url: "/auth/mfa/enroll",
      headers: { "content-type": "application/json" },
      payload: {
        email,
        password: ownerPassword,
        code: generateTotpCode(secret ?? ""),
      },
    });
    expect(verifyEnrollment.statusCode).toBe(200);
    expect(verifyEnrollment.headers["set-cookie"]).toContain(
      "onecore_session=",
    );
    expect(identity.sessions.size).toBe(2);
    await app.close();
  });

  it("rejects anonymous, non-Superadmin, role-spoofed, malformed, and invalid-token requests", async () => {
    const identity = setupIdentity();
    const mailer = vi.fn().mockResolvedValue({
      accepted: true,
      status: "QUEUED",
      provider: "resend",
    });
    const app = appFor(identity, mailer);
    const anonymous = await app.inject({
      method: "POST",
      url: `/platform/organization-applications/${organizationId}/owner-invitation`,
      headers: {
        origin: "https://admin.example.test",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);

    const invalidToken = await app.inject({
      method: "POST",
      url: "/auth/owner-credential-setup",
      headers: {
        origin: "https://admin.example.test",
        "content-type": "application/json",
      },
      payload: {
        token: randomBytes(32).toString("base64url"),
        password: ownerPassword,
      },
    });
    expect(invalidToken.statusCode).toBe(400);

    const spoofedSetup = await app.inject({
      method: "POST",
      url: "/auth/owner-credential-setup",
      headers: {
        origin: "https://admin.example.test",
        "content-type": "application/json",
      },
      payload: {
        token: randomBytes(32).toString("base64url"),
        password: ownerPassword,
        organizationId,
        role: "Organization Owner",
      },
    });
    expect(spoofedSetup.statusCode).toBe(400);

    const passwordHash = await hashPassword(ownerPassword, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
      outputLen: 32,
    });
    identity.addUser({
      id: "ad4c7a8e-8393-446f-8bb4-617cda5ab12f",
      email: "not-admin@example.test",
      displayName: "Not an Admin",
      status: "ACTIVE",
      passwordHash,
      failedLoginAttempts: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: null,
    });
    const sessionSecret = randomBytes(32).toString("base64url");
    await identity.createSession(
      {
        secretHash: createHash("sha256").update(sessionSecret).digest("hex"),
        userId: "ad4c7a8e-8393-446f-8bb4-617cda5ab12f",
        organizationId: null,
        branchId: null,
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: "127.0.0.1",
        userAgent: "owner-setup-test",
      },
      crypto.randomUUID(),
      new Date(),
    );
    const unauthorized = await app.inject({
      method: "POST",
      url: `/platform/organization-applications/${organizationId}/owner-invitation`,
      headers: {
        cookie: `onecore_session=${sessionSecret}`,
        origin: "https://admin.example.test",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(mailer).not.toHaveBeenCalled();
    await app.close();
  });

  it("rate-limits credential setup attempts", async () => {
    const app = appFor(
      setupIdentity(),
      vi.fn().mockResolvedValue({
        accepted: false,
        status: "DEFERRED",
        provider: "resend",
      }),
      1,
    );
    const request = () =>
      app.inject({
        method: "POST",
        url: "/auth/owner-credential-setup",
        headers: {
          origin: "https://admin.example.test",
          "content-type": "application/json",
        },
        payload: {
          token: randomBytes(32).toString("base64url"),
          password: ownerPassword,
        },
      });
    expect((await request()).statusCode).toBe(400);
    expect((await request()).statusCode).toBe(429);
    await app.close();
  });
});
