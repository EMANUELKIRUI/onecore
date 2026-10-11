import type { JobService } from "@onecore/database";
import { sanitizeErrorForLog } from "@onecore/config";
import type { WorkerConfig } from "./config.js";
import { createLogger } from "@onecore/config";

type WorkerLogger = ReturnType<typeof createLogger>;
type WorkerJobService = Pick<
  JobService,
  "listWorkerOrganizations" | "listWorkerBranches" | "processTenantBatch"
>;

interface WorkerScope {
  organizationId: string;
  branchId: string | null;
}

async function discoverScopes(jobs: WorkerJobService): Promise<WorkerScope[]> {
  const organizations = await jobs.listWorkerOrganizations();
  const scopes: WorkerScope[] = [];
  for (const organizationId of organizations) {
    const branches = await jobs.listWorkerBranches(organizationId);
    scopes.push({ organizationId, branchId: null });
    scopes.push(...branches.map((branchId) => ({ organizationId, branchId })));
  }
  return scopes;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runWorker(
  jobs: WorkerJobService,
  config: Pick<WorkerConfig, "pollIntervalMilliseconds" | "concurrency">,
  logger: WorkerLogger,
  signal: AbortSignal,
  workerId = "worker",
): Promise<void> {
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    let scopes: WorkerScope[];
    try {
      scopes = await discoverScopes(jobs);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const backoff = Math.min(
        config.pollIntervalMilliseconds * 2 ** Math.min(consecutiveFailures, 4),
        60_000,
      );
      logger.error(
        { err: sanitizeErrorForLog(error), backoffMilliseconds: backoff },
        "worker.discovery.failed",
      );
      await delay(backoff, signal);
      continue;
    }

    if (scopes.length === 0) {
      logger.info({ scopes: 0 }, "worker.poll.idle");
      await delay(config.pollIntervalMilliseconds, signal);
      continue;
    }

    let claimed = 0;
    let errors = 0;
    for (
      let offset = 0;
      offset < scopes.length && !signal.aborted;
      offset += config.concurrency
    ) {
      const batch = scopes.slice(offset, offset + config.concurrency);
      const results = await Promise.allSettled(
        batch.map(({ organizationId, branchId }) =>
          jobs.processTenantBatch(organizationId, branchId, workerId, {
            batchSize: 1,
            jobTypes: ["core.workflow.execute"],
            onJobClaimed: (job) =>
              logger.info(
                {
                  jobId: job.id,
                  jobType: job.jobType,
                  organizationId: job.organizationId,
                  branchId: job.branchId,
                  attempt: job.attempt,
                },
                "worker.job.claimed",
              ),
            onJobOutcome: (job) =>
              logger.info(
                {
                  jobId: job.jobId,
                  jobType: job.jobType,
                  organizationId: job.organizationId,
                  branchId: job.branchId,
                  attempt: job.attempt,
                  outcome: job.outcome,
                },
                "worker.job.outcome",
              ),
          }),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          errors += 1;
          logger.error(
            { err: sanitizeErrorForLog(result.reason) },
            "worker.scope.failed",
          );
        } else {
          claimed += result.value?.claimed ?? 0;
        }
      }
    }

    logger.info(
      { scopes: scopes.length, claimed, errors },
      "worker.poll.completed",
    );
    if (signal.aborted) break;
    if (claimed === 0 || errors > 0) {
      const backoff =
        errors > 0
          ? Math.min(
              config.pollIntervalMilliseconds * 2 ** Math.min(errors, 4),
              60_000,
            )
          : config.pollIntervalMilliseconds;
      await delay(backoff, signal);
    }
  }
  logger.info({}, "worker.polling.stopped");
}
