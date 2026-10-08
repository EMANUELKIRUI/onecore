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
    });
    expect(config.DATABASE_URL).toBeUndefined();
  });

  it("parses a valid port and deployment environment", () => {
    expect(
      loadConfig({ NODE_ENV: "production", PORT: "8443" }),
    ).toMatchObject({
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
    expect(
      loadConfig({ HOST: "127.0.0.1", PORT: "3000" }).HOST,
    ).toBe("127.0.0.1");
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
      }),
    ).toMatchObject({
      DATABASE_URL: "postgresql://onecore_app@localhost/onecore",
      AUTH_ALLOWED_ORIGINS: [
        "https://business.example",
        "https://admin.example",
      ],
    });
    expect(() =>
      loadConfig({ DATABASE_URL: "mysql://localhost/onecore" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ AUTH_ALLOWED_ORIGINS: "https://evil.example/path" }),
    ).toThrow(ConfigurationError);
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
