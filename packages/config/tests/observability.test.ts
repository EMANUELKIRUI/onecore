import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import {
  classifyError,
  getRequestContext,
  redactSensitiveFields,
  resolveCorrelationId,
  resolveRequestId,
  runWithRequestContext,
  sanitizeErrorForLog,
  type RequestContext,
} from "../src/observability.js";

describe("observability foundations", () => {
  it("validates incoming identifiers and isolates asynchronous request contexts", async () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const generatedRequestId = resolveRequestId("not-a-uuid");
    expect(generatedRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(resolveRequestId(requestId)).toBe(requestId);
    expect(resolveCorrelationId("bad-correlation", requestId)).toBe(requestId);
    expect(resolveCorrelationId(requestId, "unused")).toBe(requestId);

    const context = (id: string): RequestContext => ({
      requestId: id,
      correlationId: id,
      userId: null,
      organizationId: null,
      branchId: null,
    });
    const results = await Promise.all(
      [requestId, generatedRequestId].map((id) =>
        runWithRequestContext(context(id), async () => {
          await Promise.resolve();
          return getRequestContext()?.requestId;
        }),
      ),
    );
    expect(results).toEqual([requestId, generatedRequestId]);
    expect(getRequestContext()).toBeUndefined();
  });

  it("classifies errors without exposing their messages", () => {
    expect(classifyError({ statusCode: 400 })).toBe("validation");
    expect(classifyError({ statusCode: 401 })).toBe("authentication");
    expect(classifyError({ statusCode: 403 })).toBe("authorization");
    expect(classifyError({ statusCode: 404 })).toBe("not_found");
    expect(classifyError({ statusCode: 409 })).toBe("conflict");
    expect(classifyError({ statusCode: 429 })).toBe("rate_limited");
    expect(classifyError({ code: "23505" })).toBe("conflict");
    expect(classifyError({ code: "08006" })).toBe("database");
    expect(
      classifyError({
        name: "DrizzleQueryError",
        cause: { code: "42501" },
      }),
    ).toBe("database");
    expect(classifyError({ code: "ECONNREFUSED" })).toBe("external_dependency");
    expect(classifyError(new Error("private internal details"))).toBe(
      "internal",
    );
  });

  it("redacts nested sensitive data from structured logs", () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger("test", "info", destination);
    logger.info(
      {
        requestId: "request-id",
        nested: {
          more: {
            secrets: {
              password: "fake-password",
              sessionSecret: "fake-session-secret",
              client_secret: "fake-client-secret",
              "set-cookie": "onecore_session=fake-session-token",
              authorization: "Bearer fake-token",
              database_url: "postgresql://fake:fake@localhost/test",
            },
          },
        },
      },
      "request completed",
    );

    const output = chunks.join("");
    expect(output).toContain("request-id");
    expect(output).not.toContain("fake-password");
    expect(output).not.toContain("fake-session-secret");
    expect(output).not.toContain("fake-client-secret");
    expect(output).not.toContain("fake-session-token");
    expect(output).not.toContain("postgresql://");
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(6);
  });

  it("redacts sensitive metadata recursively and bounds recursive payloads", () => {
    expect(
      redactSensitiveFields({
        safe: "visible",
        nested: { token: "fake-token" },
      }),
    ).toEqual({
      safe: "visible",
      nested: { token: "[REDACTED]" },
    });
    let deeplyNested: Record<string, unknown> = {};
    for (let depth = 0; depth < 12; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    expect(JSON.stringify(redactSensitiveFields(deeplyNested))).toContain(
      "[REDACTED:DEPTH]",
    );
  });

  it("removes connection strings and credential assignments from diagnostics", () => {
    const diagnostics = sanitizeErrorForLog(
      new Error(
        "failed postgres connection postgresql://fake-user:fake-password@db.test/onecore password=hidden-token",
      ),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("fake-password");
    expect(JSON.stringify(diagnostics)).not.toContain("hidden-token");
    expect(JSON.stringify(diagnostics)).toContain(
      "[REDACTED_CONNECTION_STRING]",
    );
  });

  it("extracts safe PostgreSQL diagnostics from Drizzle causes without logging SQL or params", () => {
    const postgresError = Object.assign(
      new Error("permission denied for table modules"),
      {
        code: "42501",
        schema_name: "public",
        table_name: "modules",
        constraint_name: "modules_key_unique",
        detail: "sensitive row contents",
      },
    );
    const query = "SELECT private_value FROM modules WHERE key = $1";
    const parameter = "private-parameter-value";
    const error = Object.assign(
      new Error(`Failed query: ${query}\nparams: ${parameter}`, {
        cause: postgresError,
      }),
      {
        name: "DrizzleQueryError",
        query,
        params: [parameter],
      },
    );

    expect(classifyError(error)).toBe("database");
    expect(sanitizeErrorForLog(error)).toMatchObject({
      name: "DatabaseError",
      message: "Database operation failed.",
      sqlState: "42501",
      schema: "public",
      relation: "modules",
      constraint: "modules_key_unique",
    });
    expect(JSON.stringify(sanitizeErrorForLog(error))).not.toContain(
      "sensitive row contents",
    );
    expect(JSON.stringify(sanitizeErrorForLog(error))).not.toContain(query);
    expect(JSON.stringify(sanitizeErrorForLog(error))).not.toContain(parameter);
    expect(JSON.stringify(sanitizeErrorForLog(error))).not.toContain(
      "permission denied",
    );
  });

  it("omits malformed PostgreSQL diagnostic fields", () => {
    const error = Object.assign(new Error("Failed query: SELECT secret"), {
      name: "DrizzleQueryError",
      code: "not-sqlstate",
      query: "SELECT secret",
      params: ["sensitive-value"],
      table_name: "table name with unsafe content",
    });

    expect(classifyError(error)).toBe("database");
    expect(sanitizeErrorForLog(error)).toEqual({
      name: "DatabaseError",
      message: "Database operation failed.",
    });
    expect(JSON.stringify(sanitizeErrorForLog(error))).not.toContain("SELECT");
    expect(JSON.stringify(sanitizeErrorForLog(error))).not.toContain(
      "sensitive-value",
    );
  });
});
