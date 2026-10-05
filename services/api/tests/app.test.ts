import { createHash } from "node:crypto";
import { loadConfig } from "@onecore/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";

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
    await authenticatedApp.close();
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
