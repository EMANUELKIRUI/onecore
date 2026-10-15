import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "../src/environment.js";

describe("loadConfig", () => {
  it("applies safe local defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: 3000,
      LOG_LEVEL: "info",
      AUTH_ALLOWED_ORIGINS: [],
      AUTH_SESSION_TTL_SECONDS: 43_200,
      AUTH_LOGIN_RATE_LIMIT_MAX: 5,
      AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: 60_000,
      AUTH_MFA_ENFORCEMENT: "required",
    });
    expect(config.DATABASE_URL).toBeUndefined();
  });

  it.each(["development", "test"] as const)(
    "allows temporary MFA enforcement disablement only in %s",
    (NODE_ENV) => {
      expect(
        loadConfig({ NODE_ENV, AUTH_MFA_ENFORCEMENT: "disabled" })
          .AUTH_MFA_ENFORCEMENT,
      ).toBe("disabled");
    },
  );

  it.each(["staging", "production"] as const)(
    "rejects disabled MFA enforcement in %s",
    (NODE_ENV) => {
      expect(() =>
        loadConfig({ NODE_ENV, AUTH_MFA_ENFORCEMENT: "disabled" }),
      ).toThrow(ConfigurationError);
    },
  );

  it("requires an explicit non-production environment for disabled MFA", () => {
    expect(() =>
      loadConfig({ AUTH_MFA_ENFORCEMENT: "disabled" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ NODE_ENV: "development", AUTH_MFA_ENFORCEMENT: "false" }),
    ).toThrow(ConfigurationError);
  });

  it("parses a valid port and deployment environment", () => {
    expect(loadConfig({ NODE_ENV: "production", PORT: "8443" })).toMatchObject({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: 8443,
    });
  });

  it("uses the server interface when a deployment port is provided", () => {
    expect(loadConfig({ PORT: "10000" })).toMatchObject({
      HOST: "0.0.0.0",
      PORT: 10000,
    });
  });

  it("uses the server interface in staging without a supplied port", () => {
    expect(loadConfig({ NODE_ENV: "staging" })).toMatchObject({
      HOST: "0.0.0.0",
      PORT: 3000,
    });
  });

  it("preserves an explicitly configured host", () => {
    expect(loadConfig({ HOST: "127.0.0.1", PORT: "3000" }).HOST).toBe(
      "127.0.0.1",
    );
  });

  it.each(["Production", "production ", "preview"])(
    "rejects unsupported NODE_ENV value %j",
    (NODE_ENV) => {
      expect(() => loadConfig({ NODE_ENV })).toThrow(ConfigurationError);
    },
  );

  it("validates database URLs and authentication origin configuration", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgresql://onecore_app@localhost/onecore",
        AUTH_ALLOWED_ORIGINS: "https://business.example,https://admin.example",
        BUSINESS_APP_ORIGIN: "https://business.example",
      }),
    ).toMatchObject({
      DATABASE_URL: "postgresql://onecore_app@localhost/onecore",
      AUTH_ALLOWED_ORIGINS: [
        "https://business.example",
        "https://admin.example",
      ],
      BUSINESS_APP_ORIGIN: "https://business.example",
    });
    expect(() =>
      loadConfig({ DATABASE_URL: "mysql://localhost/onecore" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ AUTH_ALLOWED_ORIGINS: "https://evil.example/path" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ BUSINESS_APP_ORIGIN: "http://business.example" }),
    ).toThrow(ConfigurationError);
  });

  it("accepts only HTTPS Resend endpoints and a sufficiently long MFA key", () => {
    expect(
      loadConfig({
        RESEND_API_KEY: "re_placeholder",
        RESEND_FROM_EMAIL: "no-reply@example.test",
        RESEND_BASE_URL: "https://api.resend.com/emails",
        MFA_ENCRYPTION_KEY: "replace-with-a-32-byte-or-longer-secret-key",
      }),
    ).toMatchObject({
      RESEND_API_KEY: "re_placeholder",
      RESEND_FROM_EMAIL: "no-reply@example.test",
      RESEND_BASE_URL: "https://api.resend.com/emails",
    });
    expect(() =>
      loadConfig({ RESEND_BASE_URL: "http://api.resend.com/emails" }),
    ).toThrow(ConfigurationError);
    expect(() => loadConfig({ MFA_ENCRYPTION_KEY: "too-short" })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects invalid values without including them in the error", () => {
    expect(() => loadConfig({ PORT: "secret-value" })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ PORT: "secret-value" })).toThrow("PORT");
    expect(() => loadConfig({ PORT: "secret-value" })).not.toThrow(
      "secret-value",
    );
  });
});
