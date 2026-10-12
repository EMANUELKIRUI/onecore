import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  sendTransactionalEmail,
  verifyTotp,
} from "../src/identity-security.js";

const encryptionKey = "replace-with-a-32-byte-or-longer-secret-key";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("identity security utilities", () => {
  it("encrypts TOTP secrets with authenticated encryption", () => {
    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, encryptionKey);

    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, encryptionKey)).toBe(secret);

    const tampered = Buffer.from(encrypted, "base64url");
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() =>
      decryptSecret(tampered.toString("base64url"), encryptionKey),
    ).toThrow();
  });

  it("accepts the current and bounded neighboring TOTP steps only", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;

    expect(verifyTotp(secret, generateTotpCode(secret, now), now)).toBe(true);
    expect(
      verifyTotp(secret, generateTotpCode(secret, now - 30_000), now),
    ).toBe(true);
    expect(
      verifyTotp(secret, generateTotpCode(secret, now - 60_000), now),
    ).toBe(false);
  });

  it("generates unique high-entropy recovery codes", () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => /^[A-F0-9]{32}$/.test(code))).toBe(true);
  });

  it("does not attempt delivery when Resend configuration is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendTransactionalEmail({
        toEmail: "user@example.test",
        subject: "Verify your email",
        text: "Use the one-time link.",
      }),
    ).resolves.toMatchObject({ accepted: false, status: "DEFERRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends through the configured HTTPS endpoint without returning credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "email-message-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTransactionalEmail({
      apiKey: "test-only-resend-key",
      fromEmail: "no-reply@example.test",
      toEmail: "user@example.test",
      subject: "Verify your email",
      text: "Use the one-time link.",
      baseUrl: "https://api.resend.test/emails",
    });

    expect(result).toEqual({
      accepted: true,
      status: "QUEUED",
      provider: "resend",
      messageId: "email-message-id",
    });
    expect(JSON.stringify(result)).not.toContain("test-only-resend-key");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.resend.test/emails"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-only-resend-key",
        }),
      }),
    );
  });

  it.each([
    [
      "provider rejection",
      async () => new Response("unavailable", { status: 503 }),
    ],
    ["network failure", async () => Promise.reject(new Error("network error"))],
  ])("reports %s without exposing provider details", async (_name, respond) => {
    const fetchMock = vi.fn().mockImplementation(respond);
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTransactionalEmail({
      apiKey: "test-only-resend-key",
      fromEmail: "no-reply@example.test",
      toEmail: "user@example.test",
      subject: "Password reset",
      text: "Use the one-time link.",
      baseUrl: "https://api.resend.test/emails",
    });

    expect(result).toMatchObject({ accepted: false, status: "FAILED" });
    expect(JSON.stringify(result)).not.toContain("test-only-resend-key");
    expect(JSON.stringify(result)).not.toContain("network error");
  });

  it("rejects a non-HTTPS Resend endpoint", async () => {
    await expect(
      sendTransactionalEmail({
        apiKey: "test-only-resend-key",
        fromEmail: "no-reply@example.test",
        toEmail: "user@example.test",
        subject: "Verify your email",
        text: "Use the one-time link.",
        baseUrl: "http://api.resend.test/emails",
      }),
    ).rejects.toThrow("must use HTTPS");
  });
});
