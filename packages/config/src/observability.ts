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

function findPostgresError(
  error: unknown,
): Record<string, unknown> | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const candidate = current as Record<string, unknown>;
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return candidate;
    }
    current = candidate.cause;
  }
  return undefined;
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
  const postgresError = findPostgresError(error);
  const code =
    typeof candidate.code === "string"
      ? candidate.code
      : typeof postgresError?.code === "string"
        ? postgresError.code
        : "";
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
  if (name === "DrizzleQueryError") return "database";
  if (/^23/.test(code)) return "conflict";
  if (/^[0-9A-Z]{5}$/.test(code)) return "database";
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

function postgresErrorMetadata(error: unknown): Record<string, string> {
  const candidate = findPostgresError(error);
  if (!candidate || typeof candidate.code !== "string") return {};
  const metadata: Record<string, string> = {};
  metadata.sqlState = candidate.code;

  for (const [target, sources] of Object.entries({
    schema: ["schema_name", "schema"],
    relation: ["table_name", "table"],
    column: ["column_name", "column"],
    constraint: ["constraint_name", "constraint"],
  })) {
    const value = sources
      .map((source) => candidate[source])
      .find((item) => typeof item === "string");
    if (
      typeof value === "string" &&
      /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value)
    ) {
      metadata[target] = value;
    }
  }

  return metadata;
}

export function sanitizeErrorForLog(error: unknown): unknown {
  const metadata = postgresErrorMetadata(error);
  if (
    metadata.sqlState ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "DrizzleQueryError")
  ) {
    return {
      name: "DatabaseError",
      message: "Database operation failed.",
      ...metadata,
    };
  }
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
