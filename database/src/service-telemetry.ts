import {
  classifyError,
  createLogger,
  getRequestContext,
  redactSensitiveFields,
} from "@onecore/config";

const logger = createLogger(
  "onecore-database",
  process.env.LOG_LEVEL ?? "info",
);

function outcomeOf(value: unknown): "SUCCESS" | "DENIED" | "NOT_FOUND" {
  if (typeof value !== "object" || value === null) {
    return value === false || value === null ? "NOT_FOUND" : "SUCCESS";
  }
  if ("allowed" in value && value.allowed === false) return "DENIED";
  return "SUCCESS";
}

function safeRecord(value: unknown): Record<string, unknown> {
  const redacted = redactSensitiveFields(value);
  return typeof redacted === "object" &&
    redacted !== null &&
    !Array.isArray(redacted)
    ? Object.fromEntries(Object.entries(redacted))
    : {};
}

export function createServiceTelemetry(
  target: ReturnType<typeof createLogger> = logger,
) {
  return {
    async observe<T>(
      operation: string,
      fields: Record<string, unknown>,
      run: () => Promise<T>,
      summarize?: (value: T) => Record<string, unknown>,
    ): Promise<T> {
      const startedAt = performance.now();
      const requestContext = getRequestContext();
      const context = redactSensitiveFields({
        ...fields,
        requestId: fields.requestId ?? requestContext?.requestId ?? null,
        correlationId:
          fields.correlationId ?? requestContext?.correlationId ?? null,
      }) as Record<string, unknown>;

      try {
        const value = await run();
        target.info(
          {
            eventType: "platform.operation.completed",
            operation,
            ...context,
            ...safeRecord(summarize?.(value) ?? {}),
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            result: outcomeOf(value),
          },
          "Platform operation completed",
        );
        return value;
      } catch (error) {
        target.error(
          {
            eventType: "platform.operation.failed",
            operation,
            ...context,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            result: "FAILURE",
            errorCategory: classifyError(error),
          },
          "Platform operation failed",
        );
        throw error;
      }
    },
  };
}

export const observeServiceOperation = createServiceTelemetry().observe;
