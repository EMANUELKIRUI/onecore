import { describe, expect, it } from "vitest";
import {
  TestEmailProvider,
  TestSmsProvider,
  TestWhatsAppProvider,
} from "./communication-providers.js";

const credential = new TextEncoder().encode("test-only-credential-material");
const input = {
  channel: "EMAIL" as const,
  deliveryId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  recipient: {
    userId: "22222222-2222-4222-8222-222222222222",
    address: "test-recipient@example.test",
  },
  subject: "Test subject",
  body: "Test body",
  configuration: { senderName: "Test" },
};

describe("deterministic communication test providers", () => {
  it("simulates email success and records only safe delivery metadata", async () => {
    const provider = new TestEmailProvider([
      { outcome: "SENT", providerMessageId: "email-test-id" },
    ]);
    const result = await provider.send(input, credential);

    expect(result).toEqual({ outcome: "SENT", providerMessageId: "email-test-id" });
    expect(provider.calls).toEqual([
      {
        channel: "EMAIL",
        deliveryId: input.deliveryId,
        idempotencyKey: input.idempotencyKey,
        recipientUserId: input.recipient.userId,
      },
    ]);
    expect(JSON.stringify(provider.calls)).not.toContain("test-only-credential-material");
    expect(JSON.stringify(provider.calls)).not.toContain(input.recipient.address);
    expect(JSON.stringify(provider.calls)).not.toContain(input.body);
  });

  it("simulates SMS retry/rate-limit results without network access", async () => {
    const provider = new TestSmsProvider([
      { outcome: "RATE_LIMITED", retryAfterSeconds: 30 },
      { outcome: "RETRYABLE_FAILURE", failureCode: "TEST_TRANSIENT" },
    ]);
    const smsInput = { ...input, channel: "SMS" as const, subject: null };

    expect(await provider.send(smsInput, credential)).toMatchObject({
      outcome: "RATE_LIMITED",
      retryAfterSeconds: 30,
    });
    expect(await provider.send(smsInput, credential)).toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      failureCode: "TEST_TRANSIENT",
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("simulates WhatsApp permanent failure without provider-specific payloads", async () => {
    const provider = new TestWhatsAppProvider([
      { outcome: "PERMANENT_FAILURE", failureCode: "TEST_REJECTED" },
    ]);

    expect(
      await provider.send(
        { ...input, channel: "WHATSAPP" as const, subject: null },
        credential,
      ),
    ).toEqual({ outcome: "PERMANENT_FAILURE", failureCode: "TEST_REJECTED" });
    expect(provider.calls[0]?.channel).toBe("WHATSAPP");
  });
});
