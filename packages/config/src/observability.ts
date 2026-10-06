import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type ErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "security"
  | "database"
  | "external_dependency"
  | "internal";

export interface RequestContext {
  requestId: string;
  correlationId: string;
  userId: string | null;
  organizationId: string | null;
  branchId: string | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestContext = new AsyncLocalStorage<RequestContext>();

export function resolveRequestId(value: unknown): string {
  return typeof value === "string" && uuidPattern.test(value)
    ? value
    : randomUUID();
}

export function resolveCorrelationId(
  value: unknown,
  requestId: string,
): string {
  return typeof value === "string" && uuidPattern.test(value)
    ? value
    : requestId;
}

export function getRequestContext(): Readonly<RequestContext> | undefined {
  return requestContext.getStore();
}

export function runWithRequestContext<T>(
  context: RequestContext,
  operation: () => T,
): T {
  return requestContext.run(context, operation);
}

export function classifyError(error: unknown): ErrorCategory {
  if (typeof error !== "object" || error === null) return "internal";

  const candidate = error as {
    code?: unknown;
    name?: unknown;
    statusCode?: unknown;
  };
  const statusCode =
    typeof candidate.statusCode === "number" ? candidate.statusCode : 0;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const name = typeof candidate.name === "string" ? candidate.name : "";

  if (
    name === "ZodError" ||
    name === "ValidationError" ||
    statusCode === 400 ||
    statusCode === 413 ||
    statusCode === 415
  ) {
    return "validation";
  }
  if (statusCode === 401) return "authentication";
  if (statusCode === 403) return "authorization";
  if (statusCode === 404) return "not_found";
  if (statusCode === 409) return "conflict";
  if (statusCode === 429) return "rate_limited";
  if (/^23/.test(code)) return "conflict";
  if (/^(08|25|28|40|42|53|54|55|57|58|XX)/.test(code)) {
    return "database";
  }
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(code)) {
    return "external_dependency";
  }
  if (name === "SecurityError") return "security";
  return "internal";
}

const sensitiveFieldPattern =
  /password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|authorization|cookie|session[_-]?(?:id|hash)|connection[_-]?string/i;

export function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[REDACTED:DEPTH]";
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveFieldPattern.test(key)
        ? "[REDACTED]"
        : redactSensitiveFields(child, depth + 1),
    ]),
  );
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_CONNECTION_STRING]")
    .replace(
      /\b(password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[REDACTED:DEPTH]";
  if (typeof value === "string") return redactDiagnosticText(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveFieldPattern.test(key)
        ? "[REDACTED]"
        : sanitizeDiagnosticValue(child, depth + 1),
    ]),
  );
}

export function sanitizeErrorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactDiagnosticText(error.message),
      ...(error.stack ? { stack: redactDiagnosticText(error.stack) } : {}),
    };
  }
  return sanitizeDiagnosticValue(error);
}

export function hashRateLimitIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
