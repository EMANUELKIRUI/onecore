import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDomainEvent, moduleManifestSchema } from "@onecore/core-domain";
import {
  type AuthorizationContext,
  type AuthorizationMetadata,
  type AuthorizationService,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
  createAuthorizationService,
  createDatabase,
  createJobHandlerRegistry,
  createJobService,
  createWorkflowJobHandler,
  JobExecutionError,
} from "@onecore/database";
import { z } from "zod";
import * as schema from "../../../database/schema/index.js";
import type { JobHandler } from "@onecore/database";

const adminDatabaseUrl = process.env.ONECORE_WORKER_TEST_ADMIN_DATABASE_URL;
const integrationDescribe = adminDatabaseUrl ? describe : describe.skip;
const databaseUrl =
  adminDatabaseUrl ?? "postgresql://127.0.0.1:1/worker-integration-disabled";
const migrationsDirectory = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);

integrationDescribe("PostgreSQL workflow worker integration", () => {
  const admin = createDatabase(databaseUrl, { maxConnections: 4 });
  const workerUrl = new URL(databaseUrl);
  workerUrl.username = "onecore_worker_login";
  workerUrl.password = "";
  const worker = createDatabase(workerUrl.toString(), { maxConnections: 8 });
  const authorization = createAuthorizationService(worker.db);

  const retryablePayloadSchema = z
    .object({
      delayFirstAttempt: z.boolean().optional(),
      failure: z.enum(["retryable", "permanent"]).optional(),
    })
    .strict();
  const retryableHandler: JobHandler<z.infer<typeof retryablePayloadSchema>> = {
    jobType: "test.worker.execute",
    owningModule: "test.worker",
    requiredModuleEntitlement: null,
    payloadSchema: retryablePayloadSchema,
    async execute(transaction, payload, context) {
      if (payload.delayFirstAttempt && context.attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
      if (payload.failure === "retryable" && context.attempt === 1) {
        throw new JobExecutionError("TEMPORARY_WORKER_FAILURE", true);
      }
      if (payload.failure === "permanent") {
        throw new JobExecutionError("PERMANENT_WORKER_FAILURE", false);
      }
      await transaction.execute(sql`
        INSERT INTO worker_test_effects (organization_id, job_id, count)
        VALUES (${context.organizationId}, ${context.jobId}, 1)
        ON CONFLICT (organization_id, job_id)
        DO UPDATE SET count = worker_test_effects.count + 1
      `);
    },
  };

  const jobs = createJobService(
    worker.db,
    authorization,
    createJobHandlerRegistry([
      createWorkflowJobHandler(worker.db, authorization),
      retryableHandler,
    ]),
  );

  async function applyMigrations() {
    for (const statement of [
      "CREATE ROLE onecore_app NOLOGIN NOSUPERUSER NOBYPASSRLS",
      "CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS",
      "CREATE ROLE onecore_worker NOLOGIN NOSUPERUSER NOBYPASSRLS",
      "CREATE ROLE onecore_worker_login LOGIN NOSUPERUSER NOBYPASSRLS",
      "GRANT onecore_worker TO onecore_worker_login",
    ]) {
      await admin.db.execute(sql.raw(statement));
    }
    const entries = await readdir(migrationsDirectory, {
      withFileTypes: true,
    });
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const migration = await readFile(
        `${migrationsDirectory}/${name}/migration.sql`,
        "utf8",
      );
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await admin.db.execute(sql.raw(statement));
      }
    }
    await admin.db.execute(
      sql.raw(`
      CREATE TABLE worker_test_effects (
        organization_id uuid NOT NULL,
        job_id uuid NOT NULL,
        count integer NOT NULL,
        PRIMARY KEY (organization_id, job_id)
      );
      ALTER TABLE worker_test_effects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE worker_test_effects FORCE ROW LEVEL SECURITY;
      CREATE POLICY worker_test_effects_tenant
        ON worker_test_effects
        USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
        WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
      GRANT SELECT, INSERT, UPDATE ON worker_test_effects TO onecore_worker;
    `),
    );
  }

  async function seedModuleEntitlement(organizationId: string) {
    const [module] = await admin.db
      .insert(schema.modules)
      .values({
        key: "core.configuration",
        name: "Platform Configuration",
        lifecycle: "AVAILABLE",
        isAvailable: true,
      })
      .onConflictDoUpdate({
        target: schema.modules.key,
        set: { lifecycle: "AVAILABLE", isAvailable: true },
      })
      .returning();
    if (!module) throw new Error("Workflow module seed failed");

    const manifest = moduleManifestSchema.parse({
      name: module.key,
      version: "1.0.0",
      displayName: module.name,
      dependencies: [],
      permissions: [],
      features: [],
      lifecycle: "AVAILABLE",
    });
    await admin.db
      .insert(schema.moduleVersions)
      .values({
        moduleId: module.id,
        version: "1.0.0",
        status: "AVAILABLE",
        manifest,
      })
      .onConflictDoNothing({
        target: [schema.moduleVersions.moduleId, schema.moduleVersions.version],
      });

    const [plan] = await admin.db
      .insert(schema.plans)
      .values({
        key: `worker-test-${organizationId}`,
        name: "Worker Test Plan",
        billingInterval: "MONTHLY",
        currencyCode: "KES",
        amount: "0",
        isAvailable: true,
      })
      .returning();
    if (!plan) throw new Error("Worker test plan seed failed");
    await admin.db.insert(schema.planModules).values({
      planId: plan.id,
      moduleId: module.id,
    });
    const [subscription] = await admin.db
      .insert(schema.subscriptions)
      .values({
        organizationId,
        status: "ACTIVE",
      })
      .returning();
    if (!subscription) throw new Error("Worker test subscription seed failed");
    await admin.db.insert(schema.subscriptionItems).values({
      organizationId,
      subscriptionId: subscription.id,
      planId: plan.id,
      moduleId: module.id,
      amount: "0",
      currencyCode: "KES",
    });
    await admin.db.insert(schema.organizationModules).values({
      organizationId,
      moduleId: module.id,
      status: "ENABLED",
      source: "SUBSCRIPTION",
    });
  }

  async function createOrganization(name: string) {
    const [organization] = await admin.db
      .insert(schema.organizations)
      .values({
        name,
        slug: `${name.toLowerCase()}-${crypto.randomUUID()}`,
        industry: "TEST",
        status: "ACTIVE",
      })
      .returning();
    if (!organization)
      throw new Error("Worker test organization was not created");
    return organization;
  }

  async function insertJob(
    organizationId: string,
    payload: unknown,
    options: { maxAttempts?: number; idempotencyKey?: string } = {},
  ) {
    const [job] = await admin.db
      .insert(schema.jobs)
      .values({
        organizationId,
        jobType: "test.worker.execute",
        payload,
        requestHash: "a".repeat(64),
        correlationId: crypto.randomUUID(),
        ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.idempotencyKey
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
      })
      .returning();
    if (!job) throw new Error("Worker test job was not created");
    return job;
  }

  it("runs actual persisted workflow jobs through registered workflow handlers", async () => {
    await applyMigrations();
    const notificationInsertPrivileges = await admin.db.execute(sql`
      SELECT
        has_column_privilege('onecore_worker', 'notifications', 'id', 'INSERT') AS notification_id_insert,
        has_column_privilege('onecore_worker', 'notifications', 'read_at', 'INSERT') AS notification_read_at_insert,
        has_column_privilege('onecore_worker', 'notifications', 'created_at', 'INSERT') AS notification_created_at_insert,
        has_column_privilege('onecore_worker', 'notification_deliveries', 'id', 'INSERT') AS delivery_id_insert,
        has_column_privilege('onecore_worker', 'notification_deliveries', 'next_attempt_at', 'INSERT') AS delivery_next_attempt_at_insert,
        has_column_privilege('onecore_worker', 'notification_deliveries', 'last_error_code', 'INSERT') AS delivery_last_error_code_insert,
        has_column_privilege('onecore_worker', 'notification_deliveries', 'created_at', 'INSERT') AS delivery_created_at_insert,
        has_column_privilege('onecore_worker', 'notification_deliveries', 'updated_at', 'INSERT') AS delivery_updated_at_insert,
        has_table_privilege('onecore_worker', 'notifications', 'INSERT') AS notification_table_insert,
        has_table_privilege('onecore_worker', 'notification_deliveries', 'INSERT') AS delivery_table_insert
    `);
    expect(notificationInsertPrivileges[0]).toEqual({
      notification_id_insert: true,
      notification_read_at_insert: true,
      notification_created_at_insert: true,
      delivery_id_insert: true,
      delivery_next_attempt_at_insert: true,
      delivery_last_error_code_insert: true,
      delivery_created_at_insert: true,
      delivery_updated_at_insert: true,
      notification_table_insert: false,
      delivery_table_insert: false,
    });
    const organization = await createOrganization("Workflow Worker");
    await seedModuleEntitlement(organization.id);
    const [workflow] = await admin.db
      .insert(schema.workflowDefinitions)
      .values({
        organizationId: organization.id,
        key: `worker-${crypto.randomUUID()}`,
        name: "Worker integration workflow",
        status: "ACTIVE",
      })
      .returning();
    if (!workflow) throw new Error("Workflow definition was not created");
    const [version] = await admin.db
      .insert(schema.workflowVersions)
      .values({
        organizationId: organization.id,
        workflowId: workflow.id,
        version: 1,
        status: "PUBLISHED",
      })
      .returning();
    if (!version) throw new Error("Workflow version was not created");
    await admin.db.insert(schema.workflowTriggers).values({
      organizationId: organization.id,
      workflowVersionId: version.id,
      triggerType: "USER_CREATED",
      configuration: {},
    });
    const [step] = await admin.db
      .insert(schema.workflowSteps)
      .values({
        organizationId: organization.id,
        workflowVersionId: version.id,
        key: "root",
        name: "Root",
        position: 0,
      })
      .returning();
    if (!step) throw new Error("Workflow step was not created");
    const event = createDomainEvent({
      eventType: "USER_CREATED",
      organizationId: organization.id,
      aggregateType: "user",
      aggregateId: crypto.randomUUID(),
      payload: {
        userId: crypto.randomUUID(),
        email: "worker@example.test",
        displayName: "Worker Integration",
      },
      metadata: {},
    });
    await admin.db.insert(schema.outboxEvents).values({
      id: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      organizationId: event.organizationId,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      metadata: event.metadata,
      version: event.eventVersion,
    });
    const [execution] = await admin.db
      .insert(schema.workflowExecutions)
      .values({
        organizationId: organization.id,
        workflowVersionId: version.id,
        sourceEventId: event.eventId,
        status: "PENDING",
        resourceType: "user",
        resourceId: event.aggregateId,
        context: {},
      })
      .returning();
    if (!execution) throw new Error("Workflow execution was not created");
    const principal = {
      userId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      organizationId: organization.id,
      membershipId: crypto.randomUUID(),
      branchId: null,
    };
    const workflowHandler = createWorkflowJobHandler(worker.db, authorization);
    const workflowJobPayload = workflowHandler.payloadSchema.parse({
      executionId: execution.id,
      eventId: event.eventId,
      principal,
    });
    const [job] = await admin.db
      .insert(schema.jobs)
      .values({
        organizationId: organization.id,
        jobType: workflowHandler.jobType,
        payload: workflowJobPayload,
        idempotencyKey: `workflow-execution:${execution.id}`,
        requestHash: "b".repeat(64),
        correlationId: event.correlationId,
        causationId: event.eventId,
      })
      .returning();
    if (!job) throw new Error("Workflow job was not created");

    const result = await jobs.processTenantBatch(
      organization.id,
      null,
      "postgres-worker-integration",
    );
    expect(result).toMatchObject({
      claimed: 1,
      succeeded: 1,
      retrying: 0,
      failed: 0,
    });
    const [storedJob] = await admin.db
      .select({ status: schema.jobs.status })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.organizationId, organization.id),
          eq(schema.jobs.id, job.id),
        ),
      );
    const [storedExecution] = await admin.db
      .select({ status: schema.workflowExecutions.status })
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, execution.id));
    expect(storedJob?.status).toBe("SUCCEEDED");
    expect(storedExecution?.status).toBe("SUCCEEDED");

    const unrelatedJob = await insertJob(organization.id, {});
    const workflowOnly = await jobs.processTenantBatch(
      organization.id,
      null,
      "workflow-only-worker",
      { jobTypes: ["core.workflow.execute"] },
    );
    expect(workflowOnly?.claimed).toBe(0);
    const [unrelatedJobState] = await admin.db
      .select({ status: schema.jobs.status })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, unrelatedJob.id));
    expect(unrelatedJobState?.status).toBe("QUEUED");
  });

  it("does not commit workflow notifications after lease expiry and recovers the job", async () => {
    const organization = await createOrganization("Workflow Lease Expiry");
    await seedModuleEntitlement(organization.id);
    const [user] = await admin.db
      .insert(schema.users)
      .values({
        email: `${crypto.randomUUID()}@example.test`,
        displayName: "Lease Recipient",
        status: "ACTIVE",
      })
      .returning();
    if (!user) throw new Error("Workflow recipient was not created");
    const [membership] = await admin.db
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organization.id,
        userId: user.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      })
      .returning();
    if (!membership) throw new Error("Workflow membership was not created");
    const [workflow] = await admin.db
      .insert(schema.workflowDefinitions)
      .values({
        organizationId: organization.id,
        key: `lease-${crypto.randomUUID()}`,
        name: "Lease expiry workflow",
        status: "ACTIVE",
      })
      .returning();
    if (!workflow) throw new Error("Workflow definition was not created");
    const [version] = await admin.db
      .insert(schema.workflowVersions)
      .values({
        organizationId: organization.id,
        workflowId: workflow.id,
        version: 1,
        status: "PUBLISHED",
      })
      .returning();
    if (!version) throw new Error("Workflow version was not created");
    await admin.db.insert(schema.workflowTriggers).values({
      organizationId: organization.id,
      workflowVersionId: version.id,
      triggerType: "USER_CREATED",
      configuration: {},
    });
    const [step] = await admin.db
      .insert(schema.workflowSteps)
      .values({
        organizationId: organization.id,
        workflowVersionId: version.id,
        key: "root",
        name: "Root",
        position: 0,
      })
      .returning();
    if (!step) throw new Error("Workflow step was not created");
    const [action] = await admin.db
      .insert(schema.workflowActions)
      .values({
        organizationId: organization.id,
        workflowStepId: step.id,
        actionType: "NOTIFICATION",
        configuration: {
          recipient: { type: "PAYLOAD_USER_ID", field: "userId" },
          notificationType: "workflow.lease",
          title: "Lease recovered",
          body: "The workflow resumed after lease recovery.",
        },
      })
      .returning();
    if (!action) throw new Error("Workflow action was not created");
    const event = createDomainEvent({
      eventType: "USER_CREATED",
      organizationId: organization.id,
      actorUserId: user.id,
      aggregateType: "user",
      aggregateId: user.id,
      payload: {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
      },
      metadata: {},
    });
    await admin.db.insert(schema.outboxEvents).values({
      id: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      organizationId: event.organizationId,
      actorUserId: event.actorUserId,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      metadata: event.metadata,
      version: event.eventVersion,
    });
    const [execution] = await admin.db
      .insert(schema.workflowExecutions)
      .values({
        organizationId: organization.id,
        workflowVersionId: version.id,
        sourceEventId: event.eventId,
        status: "PENDING",
        resourceType: "user",
        resourceId: user.id,
        context: {},
      })
      .returning();
    if (!execution) throw new Error("Workflow execution was not created");
    await admin.db.insert(schema.workflowExecutionActions).values({
      organizationId: organization.id,
      executionId: execution.id,
      workflowActionId: action.id,
    });

    const principal = {
      userId: user.id,
      sessionId: crypto.randomUUID(),
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: null,
    };
    const leaseAuthorization: AuthorizationService = {
      ...authorization,
      async withAllPermissions<T>(
        _context: AuthorizationContext | null,
        _permissionKeys: readonly string[],
        _metadata: AuthorizationMetadata,
        operation: (
          transaction: OrganizationTransaction,
          context: ResolvedAuthorizationContext,
        ) => Promise<T>,
      ) {
        const result = await worker.db.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL ROLE onecore_worker`);
          await transaction.execute(
            sql`SELECT set_config('app.current_organization_id', ${organization.id}, true)`,
          );
          await transaction.execute(
            sql`SELECT set_config('app.current_user_id', ${user.id}, true)`,
          );
          const context: ResolvedAuthorizationContext = {
            userId: user.id,
            sessionId: principal.sessionId,
            organizationId: organization.id,
            membershipId: membership.id,
            branchId: null,
            branch: null,
            branchAccessMode: "ALL",
            roles: [],
            platformRoles: [],
            permissions: [],
          };
          const value = await operation(
            transaction as unknown as OrganizationTransaction,
            context,
          );
          return { allowed: true as const, value, context };
        });
        return result;
      },
    };
    const workflowHandler = createWorkflowJobHandler(
      worker.db,
      leaseAuthorization,
    );
    const leaseJobs = createJobService(
      worker.db,
      leaseAuthorization,
      createJobHandlerRegistry([workflowHandler]),
    );
    const payload = workflowHandler.payloadSchema.parse({
      executionId: execution.id,
      eventId: event.eventId,
      principal,
    });
    await admin.db.insert(schema.jobs).values({
      organizationId: organization.id,
      jobType: workflowHandler.jobType,
      payload,
      idempotencyKey: `workflow-execution:${execution.id}`,
      requestHash: "c".repeat(64),
      correlationId: event.correlationId,
      causationId: event.eventId,
    });
    await admin.db.execute(
      sql.raw(`
      CREATE FUNCTION delay_workflow_lease_notification() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.notification_type = 'workflow.lease' THEN
          PERFORM pg_sleep(1.1);
        END IF;
        RETURN NEW;
      END;
      $function$
    `),
    );
    await admin.db.execute(
      sql.raw(`
      CREATE TRIGGER delay_workflow_lease_notification
      BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION delay_workflow_lease_notification()
    `),
    );

    const staleOutcomes: string[] = [];
    const firstAttempt = await leaseJobs.processTenantBatch(
      organization.id,
      null,
      "workflow-lease-expiry",
      {
        leaseMilliseconds: 1_000,
        onJobOutcome: ({ jobId, outcome }) => {
          if (jobId) staleOutcomes.push(outcome);
        },
      },
    );
    expect(firstAttempt?.claimed).toBe(1);
    expect(staleOutcomes).toEqual(["STALE"]);
    expect(
      await admin.db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(eq(schema.notifications.organizationId, organization.id)),
    ).toEqual([]);

    const recovery = await leaseJobs.processTenantBatch(
      organization.id,
      null,
      "workflow-lease-recovery",
      { leaseMilliseconds: 5_000 },
    );
    expect(recovery?.succeeded).toBe(1);
    expect(
      await admin.db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(eq(schema.notifications.organizationId, organization.id)),
    ).toHaveLength(1);
  }, 20_000);

  it("discovers active tenants but fails closed for cross-tenant and missing context reads", async () => {
    const tenantA = await createOrganization("Worker Tenant A");
    const tenantB = await createOrganization("Worker Tenant B");
    const jobA = await insertJob(tenantA.id, {});
    const jobB = await insertJob(tenantB.id, {});

    expect(await jobs.listWorkerOrganizations()).toEqual(
      expect.arrayContaining([tenantA.id, tenantB.id]),
    );
    const tenantScopedRows = await worker.db.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`SELECT set_config('app.current_organization_id', ${tenantA.id}, true)`,
        );
        return transaction
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(eq(schema.jobs.organizationId, tenantB.id));
      },
    );
    expect(tenantScopedRows).toEqual([]);

    const missingContextRows = await worker.db.transaction((transaction) =>
      transaction.select({ id: schema.jobs.id }).from(schema.jobs),
    );
    expect(missingContextRows).toEqual([]);
    const outcomes: string[] = [];
    const tenantResult = await jobs.processTenantBatch(
      tenantA.id,
      null,
      "tenant-isolation-worker",
      {
        onJobOutcome: ({ jobId }) => outcomes.push(jobId),
      },
    );
    expect(tenantResult?.succeeded).toBe(1);
    expect(outcomes).toContain(jobA.id);
    const [untouchedJob] = await admin.db
      .select({ status: schema.jobs.status })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobB.id));
    expect(untouchedJob?.status).toBe("QUEUED");
  });

  it("uses PostgreSQL leases for concurrent workers, retry, permanent failure, and recovery", async () => {
    const organization = await createOrganization("Worker Lifecycle");
    const concurrentJob = await insertJob(organization.id, {});
    const concurrentResults = await Promise.all([
      jobs.processTenantBatch(organization.id, null, "worker-instance-a", {
        leaseMilliseconds: 2_000,
      }),
      jobs.processTenantBatch(organization.id, null, "worker-instance-b", {
        leaseMilliseconds: 2_000,
      }),
    ]);
    expect(
      concurrentResults.reduce(
        (sum, result) => sum + (result?.claimed ?? 0),
        0,
      ),
    ).toBe(1);
    const concurrentEffect = await admin.db.execute(sql`
      SELECT count(*)::int AS count FROM worker_test_effects
      WHERE organization_id = ${organization.id} AND job_id = ${concurrentJob.id}
    `);
    expect(concurrentEffect[0]?.count).toBe(1);

    const retryJob = await insertJob(organization.id, { failure: "retryable" });
    const retryFirst = await jobs.processTenantBatch(
      organization.id,
      null,
      "worker-retry",
      {
        retryBaseMilliseconds: 100,
      },
    );
    expect(retryFirst?.retrying).toBe(1);
    await admin.db
      .update(schema.jobs)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.jobs.id, retryJob.id));
    const retrySecond = await jobs.processTenantBatch(
      organization.id,
      null,
      "worker-retry",
    );
    expect(retrySecond?.succeeded).toBe(1);

    const permanentJob = await insertJob(organization.id, {
      failure: "permanent",
    });
    const permanent = await jobs.processTenantBatch(
      organization.id,
      null,
      "worker-permanent",
    );
    expect(permanent?.failed).toBe(1);
    const [failedJob] = await admin.db
      .select({
        status: schema.jobs.status,
        lastErrorCode: schema.jobs.lastErrorCode,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, permanentJob.id));
    expect(failedJob).toEqual({
      status: "FAILED",
      lastErrorCode: "PERMANENT_WORKER_FAILURE",
    });

    const staleJob = await insertJob(
      organization.id,
      { delayFirstAttempt: true },
      { maxAttempts: 3 },
    );
    const staleOutcomes: string[] = [];
    const staleResult = await jobs.processTenantBatch(
      organization.id,
      null,
      "worker-stale",
      {
        leaseMilliseconds: 1_000,
        onJobOutcome: ({ jobId, outcome }) => {
          if (jobId === staleJob.id) staleOutcomes.push(outcome);
        },
      },
    );
    expect(staleResult?.claimed).toBe(1);
    expect(staleOutcomes).toEqual(["STALE"]);
    const [leaseAfterExpiry] = await admin.db
      .select({ status: schema.jobs.status, attempts: schema.jobs.attempts })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, staleJob.id));
    expect(leaseAfterExpiry).toEqual({ status: "RUNNING", attempts: 1 });
    const recovery = await jobs.processTenantBatch(
      organization.id,
      null,
      "worker-recovery",
      {
        leaseMilliseconds: 2_000,
      },
    );
    expect(recovery?.succeeded).toBe(1);
    const [recovered] = await admin.db
      .select({ status: schema.jobs.status, attempts: schema.jobs.attempts })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, staleJob.id));
    expect(recovered).toEqual({ status: "SUCCEEDED", attempts: 2 });
  });
});
