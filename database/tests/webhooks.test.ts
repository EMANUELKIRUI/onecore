import { describe, expect, it } from "vitest";
import {
  calculateWebhookRetryDelay,
  classifyWebhookHttpStatus,
  platformWebhookEventHandlers,
  webhookEventMatches,
} from "../src/index.js";

const deliveryId = "11111111-1111-4111-8111-111111111111";

describe("webhook event and retry contracts", () => {
  it("registers enqueue handlers for the existing event registry only", () => {
    expect(platformWebhookEventHandlers.length).toBeGreaterThan(0);
    expect(
      platformWebhookEventHandlers.every(
        (handler) =>
          handler.handlerName.startsWith("platform.webhook.enqueue.") &&
          handler.requiredPermissionKey === null &&
          handler.requiredModuleEntitlement === null,
      ),
    ).toBe(true);
    expect(
      webhookEventMatches(["CONFIGURATION_CHANGED"], "CONFIGURATION_CHANGED"),
    ).toBe(true);
    expect(webhookEventMatches(["USER_CREATED"], "CONFIGURATION_CHANGED")).toBe(
      false,
    );
  });

  it("classifies retryable and permanent HTTP results", () => {
    expect(classifyWebhookHttpStatus(204)).toBe("DELIVERED");
    expect(classifyWebhookHttpStatus(408)).toBe("RETRY");
    expect(classifyWebhookHttpStatus(429)).toBe("RETRY");
    expect(classifyWebhookHttpStatus(503)).toBe("RETRY");
    for (const status of [301, 400, 401, 403, 404, 410]) {
      expect(classifyWebhookHttpStatus(status)).toBe("PERMANENT");
    }
  });

  it("uses deterministic bounded exponential backoff with jitter", () => {
    const first = calculateWebhookRetryDelay(1, deliveryId);
    expect(first).toBe(calculateWebhookRetryDelay(1, deliveryId));
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThanOrEqual(1_500);
    expect(calculateWebhookRetryDelay(20, deliveryId)).toBeLessThanOrEqual(
      3_600_000,
    );
    expect(() => calculateWebhookRetryDelay(0, deliveryId)).toThrow();
    expect(() => calculateWebhookRetryDelay(1, "invalid")).toThrow();
  });
});
