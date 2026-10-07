import { describe, expect, it } from "vitest";
import { validateWebhookEndpoint } from "../src/webhook-endpoint.js";

describe("webhook endpoint policy", () => {
  it.each([
    "http://example.com/hook",
    "https://localhost/hook",
    "https://service.localhost/hook",
    "https://intranet/hook",
    "https://metadata.google.internal/hook",
    "https://127.0.0.1/hook",
    "https://10.1.2.3/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/hook",
    "https://[::1]/hook",
    "https://[fd00::1]/hook",
    "https://[fe80::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://example.com:8443/hook",
    "https://user:pass@example.com/hook",
    "https://example.com/hook?token=redacted",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => validateWebhookEndpoint(endpoint)).toThrow();
  });

  it("accepts public HTTPS hostnames for a controlled transport boundary", () => {
    expect(
      validateWebhookEndpoint("https://hooks.example.org/events").href,
    ).toBe("https://hooks.example.org/events");
    expect(() => validateWebhookEndpoint("file:///etc/passwd")).toThrow();
  });
});
