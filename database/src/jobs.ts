import { createHash, randomUUID } from "node:crypto";
import {
  createDomainEvent,
  enqueueJobSchema,
  jobNameSchema,
} from "@onecore/core-domain";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
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
import {
  auditLogs,
  branches,
  jobAttempts,
  jobs,
  organizations,
} from "../schema/index.js";
import { loadOrganizationModuleAccess } from "./module-entitlements.js";
import {
  resourceScopeAllowsCreate,
  resourceScopePredicate,
} from "./resource-authorization.js";
import { recordOutboxEvent } from "./outbox.js";
import type { Database } from "./index.js";
import { observeServiceOperation } from "./service-telemetry.js";

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
  jobTypes?: readonly string[];
  leaseMilliseconds?: number;
  retryBaseMilliseconds?: number;
  retryMaximumMilliseconds?: number;
  onJobClaimed?: (job: {
    id: string;
    organizationId: string;
    branchId: string | null;
    jobType: string;
    attempt: number;
  }) => void;
  onJobOutcome?: (
    job: JobWorkerOutcome & {
      organizationId: string;
      branchId: string | null;
      attempt: number;
    },
  ) => void;
}

type NormalizedJobWorkerOptions = Required<
  Pick<
    JobWorkerOptions,
    | "batchSize"
    | "leaseMilliseconds"
    | "retryBaseMilliseconds"
    | "retryMaximumMilliseconds"
  >
> & {
  jobTypes: readonly string[] | undefined;
  onJobClaimed: JobWorkerOptions["onJobClaimed"];
  onJobOutcome: JobWorkerOptions["onJobOutcome"];
};

export interface JobWorkerOutcome {
  jobId: string;
  jobType: string;
  outcome: "SUCCEEDED" | "RETRYING" | "FAILED" | "STALE";
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
    | {
        claimed: number;
        succeeded: number;
        retrying: number;
        failed: number;
      }
    | undefined
  >;
  listWorkerOrganizations(): Promise<string[]>;
  listWorkerBranches(organizationId: string): Promise<string[]>;
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

async function organizationIsActive(
  transaction: OrganizationTransaction,
  organizationId: string,
): Promise<boolean> {
  const [organization] = await transaction
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.status, "ACTIVE"),
      ),
    )
    .for("share")
    .limit(1);
  return organization !== undefined;
}

async function claimBatch(
  transaction: OrganizationTransaction,
  organizationId: string,
  branchId: string | null,
  workerId: string,
  now: Date,
  batchSize: number,
  jobTypes: readonly string[] | undefined,
  leaseMilliseconds: number,
): Promise<{
  claims: JobClaim[];
  leaseRecoveries: number;
  exhausted: number;
}> {
  const rows = await transaction
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        jobTypes ? inArray(jobs.jobType, jobTypes) : undefined,
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
  let leaseRecoveries = 0;
  let exhausted = 0;
  for (const job of rows) {
    if (job.status === "RUNNING" && job.attempts > 0) {
      leaseRecoveries += 1;
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
      await transaction.insert(auditLogs).values({
        organizationId,
        actorUserId: null,
        action: "JOB_LEASE_RECOVERED",
        resource: "job",
        resourceId: job.id,
        result: "SUCCESS",
        requestMetadata: {
          correlationId: job.correlationId,
          attempt: job.attempts,
        },
      });
    }

    if (job.attempts >= job.maxAttempts) {
      exhausted += 1;
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
        requestMetadata: {
          correlationId: job.correlationId,
          reason: "ATTEMPTS_EXHAUSTED",
        },
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
  return { claims, leaseRecoveries, exhausted };
}

class StaleJobLeaseError extends Error {}

async function handleClaim(
  transaction: OrganizationTransaction,
  claim: JobClaim,
  registry: JobHandlerRegistry,
  options: NormalizedJobWorkerOptions,
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
        await observeServiceOperation(
          "job.execute",
          {
            jobId: job.id,
            jobType: job.jobType,
            organizationId: job.organizationId,
            branchId: job.branchId,
            attempt: job.attempts,
            workerId: claim.workerId,
            correlationId: job.correlationId,
          },
          () =>
            transaction.transaction(async (savepoint) => {
              await handler.execute(savepoint, payload.data, {
                organizationId: job.organizationId,
                branchId: job.branchId,
                jobId: job.id,
                workerId: claim.workerId,
                attempt: job.attempts,
                correlationId: job.correlationId,
                causationId: job.causationId,
              });
            }),
        );
      } catch (error) {
        failure =
          error instanceof JobExecutionError
            ? error
            : new JobExecutionError("HANDLER_EXECUTION_FAILED", true);
      }
    }
  }

  if (!job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) {
    throw new StaleJobLeaseError();
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
      requestMetadata: {
        workerId: claim.workerId,
        correlationId: job.correlationId,
      },
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
      correlationId: job.correlationId,
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
      return observeServiceOperation(
        "job.enqueue",
        {
          jobType: parsed.jobType,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
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
              if (
                !resourceScopeAllowsCreate(
                  resolved,
                  "core.organization.jobs.enqueue",
                  {
                    organizationId: resolved.organizationId,
                    branchId: resolved.branchId,
                    ownerUserId: resolved.userId,
                  },
                )
              ) {
                return null;
              }
              const now = new Date();
              const id = randomUUID();
              const correlationId = metadata.correlationId ?? randomUUID();
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
                const rowScope = resourceScopePredicate(
                  resolved,
                  "core.organization.jobs.enqueue",
                  {
                    organizationId: jobs.organizationId,
                    branchId: jobs.branchId,
                    ownerUserId: jobs.createdByUserId,
                  },
                );
                if (!rowScope) return null;
                const [existing] = await transaction
                  .select({ id: jobs.id, requestHash: jobs.requestHash })
                  .from(jobs)
                  .where(
                    and(
                      rowScope,
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
              if (!inserted.length)
                throw new Error("Job insert returned no row");

              await transaction.insert(auditLogs).values({
                organizationId: resolved.organizationId,
                actorUserId: resolved.userId,
                action: "JOB_ENQUEUED",
                resource: "job",
                resourceId: id,
                result: "SUCCESS",
                requestMetadata: {
                  requestId: metadata.requestId,
                  correlationId: metadata.correlationId ?? correlationId,
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
          ),
        (result) => ({
          jobId: result.allowed ? (result.value?.id ?? null) : null,
        }),
      );
    },

    async retry(context, metadata, jobId) {
      const id = z.uuid().parse(jobId);
      return observeServiceOperation(
        "job.retry",
        {
          jobId: id,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.jobs.manage",
            metadata,
            async (transaction, resolved) => {
              const rowScope = resourceScopePredicate(
                resolved,
                "core.organization.jobs.manage",
                {
                  organizationId: jobs.organizationId,
                  branchId: jobs.branchId,
                  ownerUserId: jobs.createdByUserId,
                },
              );
              if (!rowScope) return false;
              const [job] = await transaction
                .select()
                .from(jobs)
                .where(
                  and(eq(jobs.id, id), rowScope, eq(jobs.status, "FAILED")),
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
                .where(and(eq(jobs.id, job.id), rowScope));
              await transaction.insert(auditLogs).values({
                organizationId: resolved.organizationId,
                actorUserId: resolved.userId,
                action: "JOB_REQUEUED",
                resource: "job",
                resourceId: job.id,
                result: "SUCCESS",
                requestMetadata: {
                  requestId: metadata.requestId,
                  correlationId: metadata.correlationId ?? metadata.requestId,
                },
              });
              return true;
            },
          ),
        (result) => ({ jobId: result.allowed && result.value ? id : null }),
      );
    },

    async cancel(context, metadata, jobId) {
      const id = z.uuid().parse(jobId);
      return observeServiceOperation(
        "job.cancel",
        {
          jobId: id,
          organizationId: context?.organizationId ?? null,
          branchId: context?.branchId ?? null,
          actorUserId: context?.userId ?? null,
          requestId: metadata.requestId,
          correlationId: metadata.correlationId ?? metadata.requestId,
        },
        () =>
          authorization.withPermission(
            context,
            "core.organization.jobs.manage",
            metadata,
            async (transaction, resolved) => {
              const rowScope = resourceScopePredicate(
                resolved,
                "core.organization.jobs.manage",
                {
                  organizationId: jobs.organizationId,
                  branchId: jobs.branchId,
                  ownerUserId: jobs.createdByUserId,
                },
              );
              if (!rowScope) return false;
              const [job] = await transaction
                .select()
                .from(jobs)
                .where(
                  and(
                    eq(jobs.id, id),
                    rowScope,
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
                .where(and(eq(jobs.id, job.id), rowScope));
              await transaction.insert(auditLogs).values({
                organizationId: resolved.organizationId,
                actorUserId: resolved.userId,
                action: "JOB_CANCELLED",
                resource: "job",
                resourceId: job.id,
                result: "SUCCESS",
                requestMetadata: {
                  requestId: metadata.requestId,
                  correlationId: metadata.correlationId ?? metadata.requestId,
                },
              });
              return true;
            },
          ),
        (result) => ({ jobId: result.allowed && result.value ? id : null }),
      );
    },

    async processTenantBatch(
      organizationId,
      branchId,
      workerId,
      requestedOptions = {},
    ) {
      const safeWorkerId = normalizedWorkerId(workerId);
      const options: NormalizedJobWorkerOptions = {
        batchSize: Math.min(Math.max(requestedOptions.batchSize ?? 10, 1), 100),
        jobTypes: requestedOptions.jobTypes
          ? [
              ...new Set(
                requestedOptions.jobTypes.map((jobType) =>
                  jobNameSchema.parse(jobType),
                ),
              ),
            ]
          : undefined,
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
        onJobClaimed: requestedOptions.onJobClaimed,
        onJobOutcome: requestedOptions.onJobOutcome,
      };
      const batch = await withOrganizationTransaction(
        database,
        organizationId,
        async (transaction) => {
          if (!(await organizationIsActive(transaction, organizationId))) {
            return undefined;
          }
          if (
            !(await establishWorkerBranch(
              transaction,
              organizationId,
              branchId,
            ))
          ) {
            return undefined;
          }
          return observeServiceOperation(
            "job.claim_batch",
            {
              organizationId,
              branchId,
              workerId: safeWorkerId,
            },
            () =>
              claimBatch(
                transaction,
                organizationId,
                branchId,
                safeWorkerId,
                new Date(),
                options.batchSize,
                options.jobTypes,
                options.leaseMilliseconds,
              ),
            (result) => ({
              claimed: result.claims.length,
              leaseRecoveries: result.leaseRecoveries,
              exhausted: result.exhausted,
            }),
          );
        },
      );
      if (batch === undefined) return undefined;

      const { claims } = batch;
      for (const claim of claims) {
        options.onJobClaimed?.({
          id: claim.id,
          organizationId,
          branchId: claim.branchId,
          jobType: claim.jobType,
          attempt: claim.attempts,
        });
      }
      const result = {
        claimed: claims.length,
        succeeded: 0,
        retrying: 0,
        failed: 0,
      };
      for (const claim of claims) {
        let outcome: JobWorkerOutcome["outcome"];
        try {
          outcome =
            (await observeServiceOperation(
              "job.attempt",
              {
                jobId: claim.id,
                jobType: claim.jobType,
                organizationId,
                branchId: claim.branchId,
                attempt: claim.attempts,
                workerId: safeWorkerId,
                correlationId: claim.correlationId,
              },
              () =>
                withOrganizationTransaction(
                  database,
                  organizationId,
                  async (transaction) => {
                    if (
                      !(await organizationIsActive(transaction, organizationId))
                    ) {
                      return "STALE" as const;
                    }
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
                ),
              (attemptResult) => ({ attemptResult: attemptResult ?? "STALE" }),
            )) ?? "STALE";
        } catch (error) {
          if (!(error instanceof StaleJobLeaseError)) throw error;
          outcome = "STALE";
        }
        options.onJobOutcome?.({
          jobId: claim.id,
          jobType: claim.jobType,
          outcome,
          organizationId,
          branchId: claim.branchId,
          attempt: claim.attempts,
        });
        if (outcome === "SUCCEEDED") result.succeeded += 1;
        else if (outcome === "RETRYING") result.retrying += 1;
        else if (outcome === "FAILED") result.failed += 1;
      }
      return result;
    },
    async listWorkerOrganizations() {
      const rows = await database
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.status, "ACTIVE"))
        .orderBy(asc(organizations.id));
      return rows.map(({ id }) => id);
    },
    async listWorkerBranches(organizationId) {
      return (
        (await withOrganizationTransaction(
          database,
          organizationId,
          async (transaction) => {
            if (!(await organizationIsActive(transaction, organizationId))) {
              return [];
            }
            const rows = await transaction
              .select({ id: branches.id })
              .from(branches)
              .where(
                and(
                  eq(branches.organizationId, organizationId),
                  eq(branches.status, "ACTIVE"),
                ),
              )
              .orderBy(asc(branches.id));
            return rows.map(({ id }) => id);
          },
        )) ?? []
      );
    },
  };
}
