import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_VALIDITY_SECONDS = 300;
export const WEBHOOK_PAYLOAD_MAX_BYTES = 65_536;

const minimumSecretBytes = 32;
const deliveryIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const signatureHeaderPattern = /^v1=([a-f0-9]{64})$/;

export interface WebhookSignatureInput {
  secret: Uint8Array;
  deliveryId: string;
  timestamp: number;
  payload: Uint8Array;
}

function isValidSecret(secret: Uint8Array): boolean {
  return secret.byteLength >= minimumSecretBytes;
}

function signatureDigest(
  secret: Uint8Array,
  deliveryId: string,
  timestamp: number,
  payload: Uint8Array,
): Buffer {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.`, "utf8")
    .update(payload)
    .digest();
}

export function signWebhookPayload(input: WebhookSignatureInput): string {
  const { secret, deliveryId, timestamp, payload } = input;
  if (!isValidSecret(secret)) {
    throw new TypeError("Webhook signing secret must be at least 32 bytes");
  }
  if (!deliveryIdPattern.test(deliveryId)) {
    throw new TypeError("Webhook delivery ID is invalid");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Webhook timestamp must be a non-negative integer");
  }
  if (payload.byteLength > WEBHOOK_PAYLOAD_MAX_BYTES) {
    throw new TypeError("Webhook payload exceeds the maximum size");
  }

  const digest = signatureDigest(secret, deliveryId, timestamp, payload);
  return `v1=${digest.toString("hex")}`;
}

export function verifyWebhookSignature(
  input: WebhookSignatureInput & {
    signature: string;
    nowSeconds?: number;
  },
): boolean {
  const { secret, deliveryId, timestamp, payload, signature } = input;
  const nowSeconds = input.nowSeconds ?? Date.now() / 1_000;
  if (
    !isValidSecret(secret) ||
    !deliveryIdPattern.test(deliveryId) ||
    payload.byteLength > WEBHOOK_PAYLOAD_MAX_BYTES ||
    !Number.isFinite(nowSeconds) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    return false;
  }

  const match = signatureHeaderPattern.exec(signature);
  if (!match) return false;
  const signatureHex = match[1];
  if (
    signatureHex === undefined ||
    Math.abs(nowSeconds - timestamp) > WEBHOOK_SIGNATURE_VALIDITY_SECONDS
  ) {
    return false;
  }

  const expected = signatureDigest(secret, deliveryId, timestamp, payload);
  const supplied = Buffer.from(signatureHex, "hex");
  return (
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
}
