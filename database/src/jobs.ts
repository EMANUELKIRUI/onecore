import { createHash, randomUUID } from "node:crypto";
import {
  createDomainEvent,
  enqueueJobSchema,
  jobNameSchema,
} from "@onecore/core-domain";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationResult,
  AuthorizationService,
  ResolvedAuthorizationContext,
} from "./authorization.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import { withOrganizationTransaction } from "./tenant-context.js";
import { auditLogs, branches, jobAttempts, jobs } from "../schema/index.js";
import { loadOrganizationModuleAccess } from "./module-entitlements.js";
import { recordOutboxEvent } from "./outbox.js";
import type { Database } from "./index.js";

export interface JobHandlerContext {
  organizationId: string;
  branchId: string | null;
  jobId: string;
  workerId: string;
  attempt: number;
  correlationId: string;
  causationId: string | null;
}

export interface JobHandler<TPayload = unknown> {
  jobType: string;
  owningModule: string;
  requiredModuleEntitlement: string | null;
  payloadSchema: z.ZodType<TPayload>;
  execute(
    transaction: OrganizationTransaction,
    payload: TPayload,
    context: JobHandlerContext,
  ): Promise<void>;
}

export interface JobHandlerRegistry {
  get(jobType: string): JobHandler | undefined;
  list(): readonly JobHandler[];
}

export function createJobHandlerRegistry(
  handlers: readonly JobHandler[],
): JobHandlerRegistry {
  const byType = new Map<string, JobHandler>();
  for (const handler of handlers) {
    jobNameSchema.parse(handler.jobType);
    if (byType.has(handler.jobType)) {
      throw new TypeError(`Duplicate job handler: ${handler.jobType}`);
    }
    if (
      !/^[a-z][a-z0-9_.-]{2,99}$/.test(handler.owningModule) ||
      (handler.requiredModuleEntitlement !== null &&
        handler.requiredModuleEntitlement !== handler.owningModule)
    ) {
      throw new TypeError(`Invalid job handler ownership: ${handler.jobType}`);
    }
    byType.set(handler.jobType, handler);
  }
  return {
    get: (jobType) => byType.get(jobType),
    list: () => [...byType.values()],
  };
}

export class JobExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "JobExecutionError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with different job input");
    this.name = "IdempotencyConflictError";
  }
}

export interface JobClaim {
  id: string;
  organizationId: string;
  branchId: string | null;
  jobType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  workerId: string;
  leaseToken: string;
  correlationId: string;
  causationId: string | null;
}

export interface JobWorkerOptions {
  batchSize?: number;
  leaseMilliseconds?: number;
  retryBaseMilliseconds?: number;
  retryMaximumMilliseconds?: number;
}

export interface JobService {
  enqueue(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    input: unknown,
  ): Promise<AuthorizationResult<{ id: string } | null>>;
  retry(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    jobId: string,
  ): Promise<AuthorizationResult<boolean>>;
  cancel(
    context: AuthorizationContext | null,
    metadata: AuthorizationMetadata,
    jobId: string,
  ): Promise<AuthorizationResult<boolean>>;
  processTenantBatch(
    organizationId: string,
    branchId: string | null,
    workerId: string,
    options?: JobWorkerOptions,
  ): Promise<
    | { claimed: number; succeeded: number; retrying: number; failed: number }
    | undefined
  >;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (!/^[a-zA-Z0-9_.:-]{1,150}$/.test(normalized)) {
    throw new TypeError("Invalid worker identifier");
  }
  return normalized;
}

function eventForJob(
  type: "JOB_ENQUEUED" | "JOB_COMPLETED" | "JOB_FAILED",
  organizationId: string,
  branchId: string | null,
  jobId: string,
  jobType: string,
  correlationId: string,
  actorUserId?: string,
  failureKind?: "PERMANENT" | "RETRIES_EXHAUSTED",
) {
  return createDomainEvent({
    eventType: type,
    organizationId,
    ...(branchId ? { branchId } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    correlationId,
    aggregateType: "platform_job",
    aggregateId: jobId,
    payload:
      type === "JOB_FAILED"
        ? {
            jobId,
            jobType,
            failureKind: failureKind ?? "RETRIES_EXHAUSTED",
          }
        : { jobId, jobType },
    metadata: {},
  });
}

async function establishWorkerBranch(
  transaction: OrganizationTransaction,
  organizationId: string,
  branchId: string | null,
): Promise<boolean> {
  if (!branchId) return true;
  const [branch] = await transaction
    .select({ id: branches.id })
    .from(branches)
    .where(
      and(
        eq(branches.id, branchId),
        eq(branches.organizationId, organizationId),
        eq(branches.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!branch) return false;
  await transaction.execute(
    sql`select set_config('app.current_branch_id', ${branchId}, true)`,
  );
  return true;
}

export function calculateJobRetryDelay(
  attempt: number,
  baseMilliseconds: number,
  maximumMilliseconds: number,
): number {
  return Math.min(
    baseMilliseconds * 2 ** Math.min(Math.max(attempt - 1, 0), 30),
    maximumMilliseconds,
  );
}

async function claimBatch(
  transaction: OrganizationTransaction,
  organizationId: string,
  branchId: string | null,
  workerId: string,
  now: Date,
  batchSize: number,
  leaseMilliseconds: number,
): Promise<JobClaim[]> {
  const rows = await transaction
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        or(
          and(
            inArray(jobs.status, ["QUEUED", "RETRY_WAIT"]),
            lte(jobs.scheduledAt, now),
            lte(jobs.nextAttemptAt, now),
          ),
          and(eq(jobs.status, "RUNNING"), lte(jobs.leaseExpiresAt, now)),
        ),
        branchId
          ? or(sql`${jobs.branchId} is null`, eq(jobs.branchId, branchId))
          : sql`${jobs.branchId} is null`,
      ),
    )
    .orderBy(desc(jobs.priority), asc(jobs.createdAt), asc(jobs.id))
    .limit(batchSize)
    .for("update", { skipLocked: true });

  const claims: JobClaim[] = [];
  for (const job of rows) {
    if (job.status === "RUNNING" && job.attempts > 0) {
      await transaction
        .update(jobAttempts)
        .set({ outcome: "ABANDONED", completedAt: now })
        .where(
          and(
            eq(jobAttempts.organizationId, organizationId),
            eq(jobAttempts.jobId, job.id),
            eq(jobAttempts.attempt, job.attempts),
            eq(jobAttempts.outcome, "RUNNING"),
          ),
        );
    }

    if (job.attempts >= job.maxAttempts) {
      await transaction
        .update(jobs)
        .set({
          status: "FAILED",
          failedAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "ATTEMPTS_EXHAUSTED",
          updatedAt: now,
        })
        .where(eq(jobs.id, job.id));
      await transaction.insert(auditLogs).values({
        organizationId,
        actorUserId: null,
        action: "JOB_FAILED",
        resource: "job",
        resourceId: job.id,
        result: "FAILURE",
        requestMetadata: { reason: "ATTEMPTS_EXHAUSTED" },
      });
      await recordOutboxEvent(
        transaction,
        eventForJob(
          "JOB_FAILED",
          organizationId,
          job.branchId,
          job.id,
          job.jobType,
          job.correlationId,
          undefined,
          "RETRIES_EXHAUSTED",
        ),
      );
      continue;
    }

    const attempt = job.attempts + 1;
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
    await transaction
      .update(jobs)
      .set({
        status: "RUNNING",
        attempts: attempt,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt,
        startedAt: job.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id));
    await transaction.insert(jobAttempts).values({
      organizationId,
      jobId: job.id,
      attempt,
      workerId,
      startedAt: now,
      outcome: "RUNNING",
    });
    claims.push({
      id: job.id,
      organizationId,
      branchId: job.branchId,
      jobType: job.jobType,
      payload: job.payload,
      attempts: attempt,
      maxAttempts: job.maxAttempts,
      workerId,
      leaseToken,
      correlationId: job.correlationId,
      causationId: job.causationId,
    });
  }
  return claims;
}

async function handleClaim(
  transaction: OrganizationTransaction,
  claim: JobClaim,
  registry: JobHandlerRegistry,
  options: Required<JobWorkerOptions>,
): Promise<"SUCCEEDED" | "RETRYING" | "FAILED" | "STALE"> {
  const [job] = await transaction
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, claim.id),
        eq(jobs.organizationId, claim.organizationId),
        eq(jobs.status, "RUNNING"),
        eq(jobs.leaseToken, claim.leaseToken),
        eq(jobs.leaseOwner, claim.workerId),
      ),
    )
    .for("update")
    .limit(1);
  if (!job) return "STALE";
  if (!job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) return "STALE";

  const handler = registry.get(job.jobType);
  let failure: JobExecutionError | undefined;
  if (!handler) {
    failure = new JobExecutionError("HANDLER_NOT_REGISTERED", false);
  } else {
    const payload = handler.payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      failure = new JobExecutionError("INVALID_JOB_PAYLOAD", false);
    } else if (handler.requiredModuleEntitlement) {
      const entitlements = await loadOrganizationModuleAccess(
        transaction,
        job.organizationId,
      );
      if (!entitlements.get(handler.requiredModuleEntitlement)?.allowed) {
        failure = new JobExecutionError("MODULE_NOT_ENTITLED", false);
      }
    }

    if (!failure) {
      try {
        await transaction.transaction(async (savepoint) => {
          await handler.execute(savepoint, payload.data, {
            organizationId: job.organizationId,
            branchId: job.branchId,
            jobId: job.id,
            workerId: claim.workerId,
            attempt: job.attempts,
            correlationId: job.correlationId,
            causationId: job.causationId,
          });
        });
      } catch (error) {
        failure =
          error instanceof JobExecutionError
            ? error
            : new JobExecutionError("HANDLER_EXECUTION_FAILED", true);
      }
    }
  }

  const now = new Date();
  if (!failure) {
    await transaction
      .update(jobs)
      .set({
        status: "SUCCEEDED",
        completedAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id));
    await transaction
      .update(jobAttempts)
      .set({ outcome: "SUCCEEDED", completedAt: now })
      .where(
        and(
          eq(jobAttempts.organizationId, job.organizationId),
          eq(jobAttempts.jobId, job.id),
          eq(jobAttempts.attempt, job.attempts),
        ),
      );
    await transaction.insert(auditLogs).values({
      organizationId: job.organizationId,
      actorUserId: null,
      action: "JOB_COMPLETED",
      resource: "job",
      resourceId: job.id,
      result: "SUCCESS",
      requestMetadata: { workerId: claim.workerId },
    });
    await recordOutboxEvent(
      transaction,
      eventForJob(
        "JOB_COMPLETED",
        job.organizationId,
        job.branchId,
        job.id,
        job.jobType,
        job.correlationId,
      ),
    );
    return "SUCCEEDED";
  }

  const retrying = failure.retryable && job.attempts < job.maxAttempts;
  const nextAttemptAt = new Date(
    now.getTime() +
      calculateJobRetryDelay(
        job.attempts,
        options.retryBaseMilliseconds,
        options.retryMaximumMilliseconds,
      ),
  );
  await transaction
    .update(jobs)
    .set({
      status: retrying ? "RETRY_WAIT" : "FAILED",
      nextAttemptAt,
      failedAt: retrying ? null : now,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: failure.code,
      updatedAt: now,
    })
    .where(eq(jobs.id, job.id));
  await transaction
    .update(jobAttempts)
    .set({
      outcome: retrying ? "RETRY_WAIT" : "FAILED",
      completedAt: now,
      errorCode: failure.code,
    })
    .where(
      and(
        eq(jobAttempts.organizationId, job.organizationId),
        eq(jobAttempts.jobId, job.id),
        eq(jobAttempts.attempt, job.attempts),
      ),
    );
  await transaction.insert(auditLogs).values({
    organizationId: job.organizationId,
    actorUserId: null,
    action: retrying ? "JOB_RETRY_SCHEDULED" : "JOB_FAILED",
    resource: "job",
    resourceId: job.id,
    result: "FAILURE",
    requestMetadata: {
      workerId: claim.workerId,
      errorCode: failure.code,
      attempt: job.attempts,
      nextAttemptAt: retrying ? nextAttemptAt.toISOString() : null,
    },
  });
  if (!retrying) {
    await recordOutboxEvent(
      transaction,
      eventForJob(
        "JOB_FAILED",
        job.organizationId,
        job.branchId,
        job.id,
        job.jobType,
        job.correlationId,
        undefined,
        failure.retryable ? "RETRIES_EXHAUSTED" : "PERMANENT",
      ),
    );
  }
  return retrying ? "RETRYING" : "FAILED";
}

export function createJobService(
  database: Database,
  authorization: AuthorizationService,
  registry: JobHandlerRegistry,
): JobService {
  return {
    async enqueue(context, metadata, input) {
      const parsed = enqueueJobSchema.parse(input);
      if (!registry.get(parsed.jobType)) {
        throw new JobExecutionError("HANDLER_NOT_REGISTERED", false);
      }
      return authorization.withPermission(
        context,
        "core.organization.jobs.enqueue",
        metadata,
        async (transaction, resolved: ResolvedAuthorizationContext) => {
          if (
            parsed.branchId !== undefined &&
            parsed.branchId !== resolved.branchId
          ) {
            return null;
          }
          const now = new Date();
          const id = randomUUID();
          const correlationId = randomUUID();
          const requestHash = createHash("sha256")
            .update(
              stableJson({
                jobType: parsed.jobType,
                payload: parsed.payload,
                branchId: resolved.branchId,
                scheduledAt: parsed.scheduledAt ?? null,
                priority: parsed.priority,
                maxAttempts: parsed.maxAttempts,
              }),
            )
            .digest("hex");
          const inserted = await transaction
            .insert(jobs)
            .values({
              id,
              organizationId: resolved.organizationId,
              branchId: resolved.branchId,
              createdByUserId: resolved.userId,
              jobType: parsed.jobType,
              payload: parsed.payload,
              idempotencyKey: parsed.idempotencyKey ?? null,
              requestHash,
              correlationId,
              status: "QUEUED",
              priority: parsed.priority,
              maxAttempts: parsed.maxAttempts,
              scheduledAt: parsed.scheduledAt
                ? new Date(parsed.scheduledAt)
                : now,
              nextAttemptAt: parsed.scheduledAt
                ? new Date(parsed.scheduledAt)
                : now,
            })
            .onConflictDoNothing()
            .returning({ id: jobs.id });

          if (!inserted.length && parsed.idempotencyKey) {
            const [existing] = await transaction
              .select({ id: jobs.id, requestHash: jobs.requestHash })
              .from(jobs)
              .where(
                and(
                  eq(jobs.organizationId, resolved.organizationId),
                  eq(jobs.jobType, parsed.jobType),
                  eq(jobs.idempotencyKey, parsed.idempotencyKey),
                ),
              )
              .limit(1);
            if (!existing) return null;
            if (existing.requestHash !== requestHash) {
              throw new IdempotencyConflictError();
            }
            return { id: existing.id };
          }
          if (!inserted.length) throw new Error("Job insert returned no row");

          await transaction.insert(auditLogs).values({
            organizationId: resolved.organizationId,
            actorUserId: resolved.userId,
            action: "JOB_ENQUEUED",
            resource: "job",
            resourceId: id,
            result: "SUCCESS",
            requestMetadata: {
              requestId: metadata.requestId,
              jobType: parsed.jobType,
            },
          });
          await recordOutboxEvent(
            transaction,
            eventForJob(
              "JOB_ENQUEUED",
              resolved.organizationId,
              resolved.branchId,
              id,
              parsed.jobType,
              correlationId,
              resolved.userId,
            ),
          );
          return { id };
        },
      );
    },

    async retry(context, metadata, jobId) {
      const id = z.uuid().parse(jobId);
      return authorization.withPermission(
        context,
        "core.organization.jobs.manage",
        metadata,
        async (transaction, resolved) => {
          const [job] = await transaction
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.id, id),
                eq(jobs.organizationId, resolved.organizationId),
                resolved.branchId
                  ? or(
                      isNull(jobs.branchId),
                      eq(jobs.branchId, resolved.branchId),
                    )
                  : isNull(jobs.branchId),
                eq(jobs.status, "FAILED"),
              ),
            )
            .limit(1)
            .for("update");
          if (!job) return false;
          if (job.attempts >= job.maxAttempts) {
            return false;
          }
          await transaction
            .update(jobs)
            .set({
              status: "QUEUED",
              nextAttemptAt: new Date(),
              failedAt: null,
              lastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, job.id));
          await transaction.insert(auditLogs).values({
            organizationId: resolved.organizationId,
            actorUserId: resolved.userId,
            action: "JOB_REQUEUED",
            resource: "job",
            resourceId: job.id,
            result: "SUCCESS",
            requestMetadata: { requestId: metadata.requestId },
          });
          return true;
        },
      );
    },

    async cancel(context, metadata, jobId) {
      const id = z.uuid().parse(jobId);
      return authorization.withPermission(
        context,
        "core.organization.jobs.manage",
        metadata,
        async (transaction, resolved) => {
          const [job] = await transaction
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.id, id),
                eq(jobs.organizationId, resolved.organizationId),
                resolved.branchId
                  ? or(
                      isNull(jobs.branchId),
                      eq(jobs.branchId, resolved.branchId),
                    )
                  : isNull(jobs.branchId),
                inArray(jobs.status, ["QUEUED", "RETRY_WAIT", "RUNNING"]),
              ),
            )
            .limit(1)
            .for("update");
          if (!job) return false;
          await transaction
            .update(jobs)
            .set({
              status: "CANCELLED",
              failedAt: new Date(),
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, job.id));
          await transaction.insert(auditLogs).values({
            organizationId: resolved.organizationId,
            actorUserId: resolved.userId,
            action: "JOB_CANCELLED",
            resource: "job",
            resourceId: job.id,
            result: "SUCCESS",
            requestMetadata: { requestId: metadata.requestId },
          });
          return true;
        },
      );
    },

    async processTenantBatch(
      organizationId,
      branchId,
      workerId,
      requestedOptions = {},
    ) {
      const safeWorkerId = normalizedWorkerId(workerId);
      const options: Required<JobWorkerOptions> = {
        batchSize: Math.min(Math.max(requestedOptions.batchSize ?? 10, 1), 100),
        leaseMilliseconds: Math.min(
          Math.max(requestedOptions.leaseMilliseconds ?? 60_000, 1_000),
          900_000,
        ),
        retryBaseMilliseconds: Math.min(
          Math.max(requestedOptions.retryBaseMilliseconds ?? 1_000, 100),
          60_000,
        ),
        retryMaximumMilliseconds: Math.min(
          Math.max(
            requestedOptions.retryMaximumMilliseconds ?? 3_600_000,
            1_000,
          ),
          86_400_000,
        ),
      };
      const claims = await withOrganizationTransaction(
        database,
        organizationId,
        async (transaction) => {
          if (
            !(await establishWorkerBranch(
              transaction,
              organizationId,
              branchId,
            ))
          ) {
            return undefined;
          }
          return claimBatch(
            transaction,
            organizationId,
            branchId,
            safeWorkerId,
            new Date(),
            options.batchSize,
            options.leaseMilliseconds,
          );
        },
      );
      if (claims === undefined) return undefined;

      const result = {
        claimed: claims.length,
        succeeded: 0,
        retrying: 0,
        failed: 0,
      };
      for (const claim of claims) {
        const outcome = await withOrganizationTransaction(
          database,
          organizationId,
          async (transaction) => {
            if (
              !(await establishWorkerBranch(
                transaction,
                organizationId,
                claim.branchId,
              ))
            ) {
              return "STALE" as const;
            }
            return handleClaim(transaction, claim, registry, options);
          },
        );
        if (outcome === "SUCCEEDED") result.succeeded += 1;
        else if (outcome === "RETRYING") result.retrying += 1;
        else if (outcome === "FAILED") result.failed += 1;
      }
      return result;
    },
  };
}
