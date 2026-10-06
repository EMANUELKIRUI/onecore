import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, runWithRequestContext } from "@onecore/config";
import { createServiceTelemetry } from "../src/service-telemetry.js";

describe("database service telemetry", () => {
  it("records safe operation metadata, result summaries, and request context", async () => {
    const records: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        callback();
      },
    });
    const telemetry = createServiceTelemetry(
      createLogger("test", "info", destination),
    );

    await runWithRequestContext(
      {
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "123e4567-e89b-42d3-a456-426614174001",
        userId: null,
        organizationId: null,
        branchId: null,
      },
      () =>
        telemetry.observe(
          "search.query",
          { organizationId: "tenant-a", branchId: "branch-a" },
          async () => [{ id: "result-1" }],
          (results) => ({ resultCount: results.length }),
        ),
    );

    expect(records[0]).toMatchObject({
      eventType: "platform.operation.completed",
      operation: "search.query",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "123e4567-e89b-42d3-a456-426614174001",
      organizationId: "tenant-a",
      branchId: "branch-a",
      resultCount: 1,
      result: "SUCCESS",
    });
    expect(records[0]?.durationMs).toEqual(expect.any(Number));
  });

  it("classifies failures without recording error messages or secrets", async () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const telemetry = createServiceTelemetry(
      createLogger("test", "error", destination),
    );
    const failure = new Error("database password=not-for-logs");

    await expect(
      telemetry.observe(
        "job.execute",
        { jobId: "job-1", token: "not-for-logs" },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    const output = chunks.join("");
    expect(output).toContain('"errorCategory":"internal"');
    expect(output).toContain('"token":"[REDACTED]"');
    expect(output).not.toContain("database password");
    expect(output).not.toContain("not-for-logs");
  });
});
