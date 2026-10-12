import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TOTP_PERIOD_MS = 30_000;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function normalizeBase32(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function base32Encode(value: Buffer): string {
  let output = "";
  let bits = 0;
  let bitCount = 0;
  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      output += BASE32_ALPHABET[(bits >> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) {
    output += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  }
  return output;
}

function base32ToBytes(value: string): Buffer {
  const cleaned = normalizeBase32(value);
  if (cleaned.length === 0) return Buffer.alloc(0);
  let bits = "";
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    const nextByte = bits.slice(index, index + 8);
    if (nextByte.length === 8) {
      bytes.push(parseInt(nextByte, 2));
    }
  }
  return Buffer.from(bytes);
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest().subarray(0, 32);
}

function toCounterBuffer(counter: number): Buffer {
  const buffer = Buffer.alloc(8);
  let value = BigInt(counter);
  for (let index = 7; index >= 0; index -= 1) {
    buffer[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buffer;
}

function truncateDigest(digest: Buffer): number {
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return binary % 10 ** TOTP_DIGITS;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function buildTotpProvisioningUri(
  secret: string,
  email: string,
  issuer = "OneCore",
): string {
  const account = encodeURIComponent(email.trim());
  const issuerParam = encodeURIComponent(issuer);
  return `otpauth://totp/${issuerParam}:${account}?secret=${encodeURIComponent(secret)}&issuer=${issuerParam}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${Math.round(TOTP_PERIOD_MS / 1000)}`;
}

export function generateTotpCode(
  secret: string,
  now = Date.now(),
  digits = TOTP_DIGITS,
): string {
  const key = base32ToBytes(normalizeBase32(secret));
  const counter = Math.floor(now / TOTP_PERIOD_MS);
  const digest = createHmac("sha1", key)
    .update(toCounterBuffer(counter))
    .digest();
  const value = truncateDigest(digest);
  return String(value).padStart(digits, "0");
}

export function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
  windowSize = 1,
): boolean {
  return verifyTotpStep(secret, code, now, windowSize) !== null;
}

export function verifyTotpStep(
  secret: string,
  code: string,
  now = Date.now(),
  windowSize = 1,
): number | null {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const key = base32ToBytes(normalizeBase32(secret));
  const counter = Math.floor(now / TOTP_PERIOD_MS);
  for (let offset = -windowSize; offset <= windowSize; offset += 1) {
    const digest = createHmac("sha1", key)
      .update(toCounterBuffer(counter + offset))
      .digest();
    const expected = truncateDigest(digest);
    const expectedCode = Buffer.from(
      String(expected).padStart(TOTP_DIGITS, "0"),
    );
    if (timingSafeEqual(expectedCode, Buffer.from(normalized))) {
      return counter + offset;
    }
  }
  return null;
}

export function encryptSecret(secret: string, encryptionKey: string): string {
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error("MFA encryption key is missing or too short.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(encryptionKey), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptSecret(payload: string, encryptionKey: string): string {
  const buffer = Buffer.from(payload, "base64url");
  if (buffer.length < 28) {
    throw new Error("MFA secret payload is corrupted.");
  }
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(encryptionKey),
    iv,
  );
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    return randomBytes(16).toString("hex").toUpperCase();
  });
}

export function hashVerifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface TransactionalEmailOptions {
  apiKey?: string;
  fromEmail?: string;
  toEmail: string;
  subject: string;
  text: string;
  html?: string;
  baseUrl?: string;
}

export interface TransactionalEmailResult {
  accepted: boolean;
  status: "QUEUED" | "DEFERRED" | "FAILED";
  provider: "resend";
  messageId?: string;
}

export type TransactionalEmailSender = (
  options: TransactionalEmailOptions,
) => Promise<TransactionalEmailResult>;

export async function sendTransactionalEmail(
  options: TransactionalEmailOptions,
): Promise<TransactionalEmailResult> {
  const { apiKey, fromEmail, toEmail, subject, text, html, baseUrl } = options;
  if (!apiKey || !fromEmail) {
    return {
      accepted: false,
      status: "DEFERRED",
      provider: "resend",
    };
  }

  const endpoint = new URL(baseUrl ?? "https://api.resend.com/emails");
  if (endpoint.protocol !== "https:") {
    throw new TypeError("Resend endpoint must use HTTPS");
  }

  try {
    const payload = {
      from: fromEmail,
      to: [toEmail],
      subject,
      text,
      ...(html ? { html } : {}),
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        accepted: false,
        status: "FAILED",
        provider: "resend",
      };
    }
    const json = body ? (JSON.parse(body) as { id?: string }) : {};
    const messageId = json.id;
    return {
      accepted: true,
      status: "QUEUED",
      provider: "resend",
      ...(messageId ? { messageId } : {}),
    };
  } catch {
    return {
      accepted: false,
      status: "FAILED",
      provider: "resend",
    };
  }
}
