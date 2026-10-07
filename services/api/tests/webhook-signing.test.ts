import { describe, expect, it } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_VALIDITY_SECONDS,
  WEBHOOK_PAYLOAD_MAX_BYTES,
} from "../src/webhook-signing.js";

const secret = new Uint8Array(32).fill(0x42);
const payload = new TextEncoder().encode('{"event":"record.updated"}');
const deliveryId = "11111111-1111-4111-8111-111111111111";
const timestamp = 1_800_000_000;

describe("webhook signing", () => {
  it("signs the exact payload with a stable delivery ID and timestamp", () => {
    const signature = signWebhookPayload({
      secret,
      deliveryId,
      timestamp,
      payload,
    });

    expect(signature).toBe(
      signWebhookPayload({ secret, deliveryId, timestamp, payload }),
    );
    expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(
      verifyWebhookSignature({
        secret,
        deliveryId,
        timestamp,
        payload,
        signature,
        nowSeconds: timestamp,
      }),
    ).toBe(true);
  });

  it("rejects a changed payload, secret, delivery ID, or malformed header", () => {
    const signature = signWebhookPayload({
      secret,
      deliveryId,
      timestamp,
      payload,
    });
    const verify = (
      input: Partial<Parameters<typeof verifyWebhookSignature>[0]>,
    ) =>
      verifyWebhookSignature({
        secret,
        deliveryId,
        timestamp,
        payload,
        signature,
        nowSeconds: timestamp,
        ...input,
      });

    expect(verify({ payload: new TextEncoder().encode("changed") })).toBe(
      false,
    );
    expect(verify({ secret: new Uint8Array(32).fill(0x43) })).toBe(false);
    expect(verify({ deliveryId: "another-delivery" })).toBe(false);
    expect(verify({ signature: "not-a-signature" })).toBe(false);
  });

  it("accepts signatures only within the five-minute replay window", () => {
    const signature = signWebhookPayload({
      secret,
      deliveryId,
      timestamp,
      payload,
    });
    const verifyAt = (nowSeconds: number) =>
      verifyWebhookSignature({
        secret,
        deliveryId,
        timestamp,
        payload,
        signature,
        nowSeconds,
      });

    expect(verifyAt(timestamp + WEBHOOK_SIGNATURE_VALIDITY_SECONDS)).toBe(true);
    expect(verifyAt(timestamp + WEBHOOK_SIGNATURE_VALIDITY_SECONDS + 1)).toBe(
      false,
    );
    expect(verifyAt(timestamp - WEBHOOK_SIGNATURE_VALIDITY_SECONDS)).toBe(true);
    expect(verifyAt(timestamp - WEBHOOK_SIGNATURE_VALIDITY_SECONDS - 1)).toBe(
      false,
    );
  });

  it("rejects undersized secrets and invalid signing inputs", () => {
    expect(() =>
      signWebhookPayload({
        secret: new Uint8Array(31),
        deliveryId,
        timestamp,
        payload,
      }),
    ).toThrow(/at least 32 bytes/);
    expect(() =>
      signWebhookPayload({ secret, deliveryId: "bad.id", timestamp, payload }),
    ).toThrow(/delivery ID/);
    expect(() =>
      signWebhookPayload({ secret, deliveryId, timestamp: -1, payload }),
    ).toThrow(/timestamp/);
  });

  it("rejects payloads larger than the platform limit", () => {
    expect(() =>
      signWebhookPayload({
        secret,
        deliveryId,
        timestamp,
        payload: new Uint8Array(WEBHOOK_PAYLOAD_MAX_BYTES + 1),
      }),
    ).toThrow(/maximum size/);
  });
});
