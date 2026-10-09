import { describe, expect, it } from "vitest";
import { createLogger } from "@onecore/config";
import { runWorker } from "../src/runner.js";

describe("workflow worker runner", () => {
  it("limits concurrent tenant scopes and stops polling on shutdown", async () => {
    const controller = new AbortController();
    let active = 0;
    let peakConcurrency = 0;
    let processedScopes = 0;
    const logger = createLogger("worker-test", "silent");
    const jobs = {
      async listWorkerOrganizations() {
        return ["tenant-a", "tenant-b", "tenant-c"];
      },
      async listWorkerBranches(organizationId: string) {
        return organizationId === "tenant-a" ? ["branch-a1", "branch-a2"] : [];
      },
      async processTenantBatch(
        organizationId: string,
        _branchId: string | null,
        _workerId: string,
        options: { jobTypes?: readonly string[] },
      ) {
        expect(options.jobTypes).toEqual(["core.workflow.execute"]);
        active += 1;
        peakConcurrency = Math.max(peakConcurrency, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        processedScopes += 1;
        if (processedScopes === 4) controller.abort();
        return {
          claimed: 0,
          succeeded: 0,
          retrying: 0,
          failed: 0,
        };
      },
    };

    await runWorker(
      jobs,
      { pollIntervalMilliseconds: 250, concurrency: 2 },
      logger,
      controller.signal,
      "worker-test-id",
    );

    expect(peakConcurrency).toBe(2);
    expect(processedScopes).toBe(4);
    expect(active).toBe(0);
  });
});
