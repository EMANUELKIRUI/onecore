import { describe, expect, it } from "vitest";
import type { SecretReference, SecretStore } from "@onecore/core-domain";
import {
  failClosedWebhookTransport,
  unavailableSecretStore,
  type OutboundWebhookRequest,
  type OutboundWebhookTransport,
} from "../src/integration-boundaries.js";
import {
  performWebhookDeliveryAttempt,
  resolveWebhookAttemptTransition,
  webhookIntegrationAllowsDelivery,
  type WebhookDeliveryClaim,
} from "../src/webhook-delivery.js";
import { verifyWebhookSignature } from "../src/webhook-signing.js";

const keyBytes = new Uint8Array(32).fill(0x44);
const keyText = new TextDecoder().decode(keyBytes);
const now = new Date("2026-10-07T12:00:00.000Z");
const claim: WebhookDeliveryClaim = {
  deliveryId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  subscriptionId: "33333333-3333-4333-8333-333333333333",
  eventId: "44444444-4444-4444-8444-444444444444",
  endpointUrl: "https://hooks.example.org/events",
  signingSecretReference: "opaque-test-reference",
  attemptNumber: 1,
  maxAttempts: 8,
  leaseToken: "55555555-5555-4555-8555-555555555555",
  payload: new TextEncoder().encode('{"event":"test.only"}'),
};

function testSecretStore(secret: Uint8Array = keyBytes): SecretStore {
  return {
    store: async () => "new-test-reference" as SecretReference,
    rotate: async ({ reference }) => reference,
    withSecret: async (_input, use) => use(secret),
    delete: async () => undefined,
    metadata: async () => ({
      createdAt: now,
      updatedAt: now,
      version: 1,
    }),
  };
}

function testTransport(
  respond: (request: OutboundWebhookRequest) => number | Promise<number>,
): OutboundWebhookTransport {
  return {
    securityPolicy: "SSRF_SAFE",
    async send(request) {
      return {
        statusCode: await respond(request),
        responseMetadata: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": "15",
          authorization: "must-not-be-persisted",
          "set-cookie": "must-not-be-persisted",
          body: "must-not-be-persisted",
        },
      };
    },
  };
}

describe("webhook delivery attempts", () => {
  it("uses subscription activity as the delivery switch for metadata-only webhook integrations", () => {
    expect(webhookIntegrationAllowsDelivery("PENDING")).toBe(true);
    expect(webhookIntegrationAllowsDelivery("ACTIVE")).toBe(true);
    expect(webhookIntegrationAllowsDelivery("DISABLED")).toBe(false);
    expect(webhookIntegrationAllowsDelivery("REVOKED")).toBe(false);
    expect(webhookIntegrationAllowsDelivery("UNKNOWN")).toBe(false);
  });

  it("transitions retryable and permanent failures to retry or dead letter", () => {
    const retryResult = {
      status: "RETRYING" as const,
      httpStatus: 503,
      failureCode: "HTTP_503",
      responseMetadata: {},
    };
    expect(resolveWebhookAttemptTransition(retryResult, 1, 8)).toEqual({
      deliveryStatus: "RETRYING",
      attemptStatus: "RETRYING",
      failureCode: "HTTP_503",
    });
    expect(resolveWebhookAttemptTransition(retryResult, 8, 8)).toEqual({
      deliveryStatus: "DEAD_LETTERED",
      attemptStatus: "DEAD_LETTERED",
      failureCode: "MAX_ATTEMPTS_EXHAUSTED",
    });
    expect(
      resolveWebhookAttemptTransition(
        {
          status: "FAILED",
          httpStatus: 401,
          failureCode: "HTTP_401",
          responseMetadata: {},
        },
        1,
        8,
      ),
    ).toEqual({
      deliveryStatus: "DEAD_LETTERED",
      attemptStatus: "FAILED",
      failureCode: "HTTP_401",
    });
    expect(() => resolveWebhookAttemptTransition(retryResult, 9, 8)).toThrow();
  });

  it("signs exact bytes and preserves a stable delivery ID without exposing the key", async () => {
    const sent: OutboundWebhookRequest[] = [];
    const transport = testTransport((request) => {
      sent.push(request);
      return 204;
    });
    const first = await performWebhookDeliveryAttempt(
      claim,
      testSecretStore(),
      transport,
      now,
    );
    const second = await performWebhookDeliveryAttempt(
      { ...claim, attemptNumber: 2 },
      testSecretStore(),
      transport,
      now,
    );

    expect(first).toEqual({
      status: "DELIVERED",
      httpStatus: 204,
      failureCode: null,
      responseMetadata: {
        "content-type": "application/json",
        "retry-after": "15",
      },
    });
    expect(second).toEqual(first);
    expect(sent.map(({ deliveryId }) => deliveryId)).toEqual([
      claim.deliveryId,
      claim.deliveryId,
    ]);
    expect(
      verifyWebhookSignature({
        secret: keyBytes,
        deliveryId: sent[0]!.deliveryId,
        timestamp: sent[0]!.timestamp,
        payload: sent[0]!.payload,
        signature: sent[0]!.signature,
        nowSeconds: sent[0]!.timestamp,
      }),
    ).toBe(true);
    expect(JSON.stringify(first)).not.toContain(keyText);
  });

  it("retries network/server failures and dead-letters permanent client failures", async () => {
    const retry = await performWebhookDeliveryAttempt(
      claim,
      testSecretStore(),
      testTransport(() => 503),
      now,
    );
    const permanent = await performWebhookDeliveryAttempt(
      claim,
      testSecretStore(),
      testTransport(() => 401),
      now,
    );
    const network = await performWebhookDeliveryAttempt(
      claim,
      testSecretStore(),
      {
        securityPolicy: "SSRF_SAFE",
        send: async () => {
          throw new Error("network detail must not persist");
        },
      },
      now,
    );

    expect(retry).toMatchObject({ status: "RETRYING", httpStatus: 503 });
    expect(permanent).toMatchObject({ status: "FAILED", httpStatus: 401 });
    expect(network).toMatchObject({
      status: "RETRYING",
      failureCode: "NETWORK_FAILURE",
    });
    expect(JSON.stringify(network)).not.toContain("network detail");
  });

  it("fails closed when the secret or egress backend is unavailable", async () => {
    const unavailable = await performWebhookDeliveryAttempt(
      claim,
      unavailableSecretStore,
      testTransport(() => 200),
      now,
    );
    expect(unavailable).toMatchObject({
      status: "RETRYING",
      failureCode: "SECRET_STORE_UNAVAILABLE",
    });
    await expect(
      failClosedWebhookTransport.send({
        endpointUrl: claim.endpointUrl,
        deliveryId: claim.deliveryId,
        timestamp: Math.floor(now.getTime() / 1_000),
        payload: claim.payload,
        signature:
          "v1=0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow("WEBHOOK_TRANSPORT_UNAVAILABLE");
    expect(JSON.stringify(unavailable)).not.toContain(
      "secret backend diagnostic",
    );
  });
});
