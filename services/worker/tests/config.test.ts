import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://worker:worker@127.0.0.1:5432/onecore",
};

describe("worker configuration", () => {
  it("loads bounded defaults and validates the PostgreSQL URL", () => {
    expect(loadWorkerConfig(validEnvironment)).toMatchObject({
      databaseUrl: validEnvironment.DATABASE_URL,
      pollIntervalMilliseconds: 5_000,
      concurrency: 4,
      shutdownGraceMilliseconds: 30_000,
    });
  });

  it.each([
    ["missing database URL", { DATABASE_URL: undefined }],
    ["unsupported database protocol", { DATABASE_URL: "https://example.test" }],
    ["poll interval below minimum", { WORKER_POLL_INTERVAL_MS: "249" }],
    ["poll interval above maximum", { WORKER_POLL_INTERVAL_MS: "60001" }],
    ["non-finite concurrency", { WORKER_CONCURRENCY: "Infinity" }],
    ["concurrency above maximum", { WORKER_CONCURRENCY: "17" }],
    ["negative shutdown grace", { WORKER_SHUTDOWN_GRACE_MS: "-1" }],
  ])("rejects %s without echoing configuration values", (_label, overrides) => {
    let message = "";
    try {
      loadWorkerConfig({
        ...validEnvironment,
        ...(overrides as NodeJS.ProcessEnv),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(validEnvironment.DATABASE_URL);
    expect(message).not.toContain("worker:worker");
    expect(message).not.toBe("");
  });
});
