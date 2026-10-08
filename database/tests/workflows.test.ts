import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDomainEvent } from "@onecore/core-domain";
import {
  type AuthorizationService,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
  createWorkflowEventHandlers,
  createWorkflowJobHandler,
  recordOutboxEvent,
  validateWorkflowVersionForExecution,
  type JobHandlerContext,
} from "../src/index.js";
import type { Database } from "../src/index.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
let client: PGlite;
let database: PgliteDatabase;

async function tenantTransaction<T>(
  organizationId: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    return operation(transaction as unknown as OrganizationTransaction);
  });
}

async function createTenant(name: string) {
  const [organization] = await database
    .insert(schema.organizations)
    .values({
      name,
      slug: `${name.toLowerCase()}-${crypto.randomUUID()}`,
      industry: "TEST",
      status: "ACTIVE",
    })
    .returning();
  if (!organization) throw new Error("Workflow organization was not created");
  const [user] = await database
    .insert(schema.users)
    .values({
      email: `${crypto.randomUUID()}@example.test`,
      displayName: "Workflow Test User",
      status: "ACTIVE",
    })
    .returning();
  if (!user) throw new Error("Workflow user was not created");
  const [membership] = await database
    .insert(schema.organizationMemberships)
    .values({
      organizationId: organization.id,
      userId: user.id,
      status: "ACTIVE",
      branchAccessMode: "ALL",
    })
    .returning();
  if (!membership) throw new Error("Workflow membership was not created");
  return { organization, user, membership };
}

async function createPublishedWorkflow(organizationId: string, userId: string) {
  const [workflow] = await database
    .insert(schema.workflowDefinitions)
    .values({
      organizationId,
      key: `welcome-${crypto.randomUUID()}`,
      name: "Welcome",
      status: "ACTIVE",
    })
    .returning();
  if (!workflow) throw new Error("Workflow was not created");
  const [version] = await database
    .insert(schema.workflowVersions)
    .values({
      organizationId,
      workflowId: workflow.id,
      version: 1,
      status: "PUBLISHED",
    })
    .returning();
  if (!version) throw new Error("Workflow version was not created");
  await database.insert(schema.workflowTriggers).values({
    organizationId,
    workflowVersionId: version.id,
    triggerType: "USER_CREATED",
    configuration: {},
  });
  const [step] = await database
    .insert(schema.workflowSteps)
    .values({
      organizationId,
      workflowVersionId: version.id,
      key: `notify-${crypto.randomUUID()}`,
      name: "Notify user",
      position: 0,
    })
    .returning();
  if (!step) throw new Error("Workflow step was not created");
  const [action] = await database
    .insert(schema.workflowActions)
    .values({
      organizationId,
      workflowStepId: step.id,
      actionType: "NOTIFICATION",
      configuration: {
        recipient: { type: "PAYLOAD_USER_ID", field: "userId" },
        notificationType: "workflow.welcome",
        title: "Welcome",
        body: "Welcome to the workspace.",
      },
    })
    .returning();
  if (!action) throw new Error("Workflow action was not created");
  return { workflow, version, step, action, userId };
}

function testAuthorization(activeTransaction: {
  current: OrganizationTransaction | null;
}): AuthorizationService {
  return {
    async withAllPermissions(context, permissionKeys, metadata, operation) {
      void metadata;
      if (!context?.organizationId || !context.membershipId) {
        return { allowed: false, statusCode: 401, dataScopes: [] };
      }
      const transaction = activeTransaction.current;
      if (!transaction) throw new Error("Workflow test transaction is missing");
      const resolved: ResolvedAuthorizationContext = {
        ...context,
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        branch: null,
        branchAccessMode: "ALL",
        roles: [],
        platformRoles: [],
        permissions: permissionKeys.map((key) => ({
          key,
          moduleKey: key.split(".").slice(0, -2).join("."),
          scopeType: "ORGANIZATION",
          scope: {},
        })),
      };
      const value = await operation(transaction, resolved);
      return { allowed: true, value, context: resolved };
    },
    async withPermission() {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    },
    async withAnyPermission() {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    },
    async authorize() {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    },
    async hasPermission() {
      return false;
    },
  };
}

describe("workflow execution persistence", () => {
  beforeAll(async () => {
    client = new PGlite();
    database = drizzle({ client });
    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    `);
    await applyTestMigrations(client, migrationsDirectory);
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates one tenant execution and job for duplicate registered event delivery", async () => {
    const tenant = await createTenant("Workflow Idempotency");
    const workflow = await createPublishedWorkflow(
      tenant.organization.id,
      tenant.user.id,
    );
    const otherTenant = await createTenant("Workflow Other Tenant");
    const otherWorkflow = await createPublishedWorkflow(
      otherTenant.organization.id,
      otherTenant.user.id,
    );
    const event = createDomainEvent({
      eventType: "USER_CREATED",
      organizationId: tenant.organization.id,
      actorUserId: tenant.user.id,
      aggregateType: "user",
      aggregateId: tenant.user.id,
      payload: {
        userId: tenant.user.id,
        email: tenant.user.email,
        displayName: tenant.user.displayName,
      },
      metadata: {},
    });
    const context: ResolvedAuthorizationContext = {
      userId: tenant.user.id,
      sessionId: crypto.randomUUID(),
      organizationId: tenant.organization.id,
      membershipId: tenant.membership.id,
      branchId: null,
      branch: null,
      branchAccessMode: "ALL",
      roles: [],
      platformRoles: [],
      permissions: [
        {
          key: "core.organization.workflows.manage",
          moduleKey: "core.organization",
          scopeType: "ORGANIZATION",
          scope: {},
        },
      ],
    };
    const handler = createWorkflowEventHandlers().find(
      (candidate) => candidate.eventType === event.eventType,
    );
    if (!handler) throw new Error("USER_CREATED workflow handler is missing");
    const dispatchEvent = () =>
      tenantTransaction(tenant.organization.id, (transaction) =>
        handler.handle(transaction, event, context),
      );
    await expect(
      tenantTransaction(tenant.organization.id, (transaction) =>
        handler.handle(transaction, event, {
          userId: tenant.user.id,
          sessionId: crypto.randomUUID(),
          organizationId: tenant.organization.id,
          membershipId: tenant.membership.id,
          branchId: crypto.randomUUID(),
          branch: null,
          branchAccessMode: "ALL",
          roles: [],
          platformRoles: [],
          permissions: [],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "WORKFLOW_EVENT_SCOPE_MISMATCH" });
    await database
      .update(schema.workflowDefinitions)
      .set({ status: "DRAFT" })
      .where(eq(schema.workflowDefinitions.id, workflow.workflow.id));
    await dispatchEvent();
    await database
      .update(schema.workflowDefinitions)
      .set({ status: "ACTIVE" })
      .where(eq(schema.workflowDefinitions.id, workflow.workflow.id));
    await database
      .update(schema.workflowVersions)
      .set({ status: "DRAFT" })
      .where(eq(schema.workflowVersions.id, workflow.version.id));
    await dispatchEvent();
    const draftExecutions = await database
      .select({ id: schema.workflowExecutions.id })
      .from(schema.workflowExecutions)
      .where(
        eq(schema.workflowExecutions.organizationId, tenant.organization.id),
      );
    expect(draftExecutions).toEqual([]);
    await database
      .update(schema.workflowVersions)
      .set({ status: "PUBLISHED" })
      .where(eq(schema.workflowVersions.id, workflow.version.id));
    const [condition] = await database
      .insert(schema.workflowConditions)
      .values({
        organizationId: tenant.organization.id,
        workflowStepId: workflow.step.id,
        expression: {
          field: "displayName",
          operator: "EQ",
          value: tenant.user.displayName,
        },
      })
      .returning();
    if (!condition) throw new Error("Workflow condition was not created");
    await tenantTransaction(tenant.organization.id, (transaction) =>
      validateWorkflowVersionForExecution(
        transaction,
        tenant.organization.id,
        workflow.version.id,
      ),
    );
    await database
      .update(schema.workflowConditions)
      .set({
        expression: {
          field: "unregisteredField",
          operator: "EQ",
          value: "invalid",
        },
      })
      .where(eq(schema.workflowConditions.id, condition.id));
    await expect(
      tenantTransaction(tenant.organization.id, (transaction) =>
        validateWorkflowVersionForExecution(
          transaction,
          tenant.organization.id,
          workflow.version.id,
        ),
      ),
    ).rejects.toThrow();
    await database
      .update(schema.workflowConditions)
      .set({
        expression: {
          field: "displayName",
          operator: "EQ",
          value: tenant.user.displayName,
        },
      })
      .where(eq(schema.workflowConditions.id, condition.id));

    await tenantTransaction(tenant.organization.id, async (transaction) => {
      await recordOutboxEvent(transaction, event);
      await handler.handle(transaction, event, context);
      await handler.handle(transaction, event, context);
    });

    const executions = await database
      .select()
      .from(schema.workflowExecutions)
      .where(
        and(
          eq(schema.workflowExecutions.organizationId, tenant.organization.id),
          eq(schema.workflowExecutions.workflowVersionId, workflow.version.id),
          eq(schema.workflowExecutions.sourceEventId, event.eventId),
        ),
      );
    const jobs = await database
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.organizationId, tenant.organization.id),
          eq(schema.jobs.jobType, "core.workflow.execute"),
        ),
      );
    expect(executions).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    const otherTenantExecutions = await database
      .select({ id: schema.workflowExecutions.id })
      .from(schema.workflowExecutions)
      .where(
        and(
          eq(
            schema.workflowExecutions.organizationId,
            otherTenant.organization.id,
          ),
          eq(
            schema.workflowExecutions.workflowVersionId,
            otherWorkflow.version.id,
          ),
        ),
      );
    expect(otherTenantExecutions).toEqual([]);
    expect(jobs[0]?.idempotencyKey).toBe(
      `workflow-execution:${executions[0]?.id}`,
    );

    const visibleToOtherTenant = await tenantTransaction(
      otherTenant.organization.id,
      (transaction) =>
        transaction
          .select({ id: schema.workflowExecutions.id })
          .from(schema.workflowExecutions),
    );
    expect(visibleToOtherTenant).toEqual([]);
    const missingTenantContext = await client.transaction(
      async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        return transaction.query("SELECT id FROM workflow_execution_actions");
      },
    );
    expect(missingTenantContext.rows).toEqual([]);

    const rls = await client.query<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
       FROM pg_class WHERE relname = 'workflow_execution_actions'`,
    );
    expect(rls.rows).toEqual([{ enabled: true, forced: true }]);
  });

  it("commits notification and action success once across duplicate job delivery", async () => {
    const tenant = await createTenant("Workflow Action Idempotency");
    const workflow = await createPublishedWorkflow(
      tenant.organization.id,
      tenant.user.id,
    );
    const event = createDomainEvent({
      eventType: "USER_CREATED",
      organizationId: tenant.organization.id,
      actorUserId: tenant.user.id,
      aggregateType: "user",
      aggregateId: tenant.user.id,
      payload: {
        userId: tenant.user.id,
        email: tenant.user.email,
        displayName: tenant.user.displayName,
      },
      metadata: {},
    });
    const principal = {
      userId: tenant.user.id,
      sessionId: crypto.randomUUID(),
      organizationId: tenant.organization.id,
      membershipId: tenant.membership.id,
      branchId: null,
    };
    let persistedExecutionId: string | undefined;
    const handler = createWorkflowEventHandlers().find(
      (candidate) => candidate.eventType === event.eventType,
    );
    if (!handler) throw new Error("USER_CREATED workflow handler is missing");

    await tenantTransaction(tenant.organization.id, async (transaction) => {
      await recordOutboxEvent(transaction, event);
      await handler.handle(transaction, event, {
        userId: tenant.user.id,
        sessionId: principal.sessionId,
        organizationId: tenant.organization.id,
        membershipId: tenant.membership.id,
        branchId: null,
        branch: null,
        branchAccessMode: "ALL",
        roles: [],
        platformRoles: [],
        permissions: [],
      });
      const [persistedExecution] = await transaction
        .select({ id: schema.workflowExecutions.id })
        .from(schema.workflowExecutions)
        .where(
          and(
            eq(
              schema.workflowExecutions.organizationId,
              tenant.organization.id,
            ),
            eq(
              schema.workflowExecutions.workflowVersionId,
              workflow.version.id,
            ),
            eq(schema.workflowExecutions.sourceEventId, event.eventId),
          ),
        )
        .limit(1);
      if (!persistedExecution) {
        throw new Error("Workflow execution was not created");
      }
      persistedExecutionId = persistedExecution.id;
    });

    const activeTransaction: {
      current: OrganizationTransaction | null;
    } = { current: null };
    const workflowJob = createWorkflowJobHandler(
      database as unknown as Database,
      testAuthorization(activeTransaction),
    );
    if (!persistedExecutionId) {
      throw new Error("Workflow execution was not persisted");
    }
    const jobPayload = workflowJob.payloadSchema.parse({
      executionId: persistedExecutionId,
      eventId: event.eventId,
      principal,
    });
    const jobContext: JobHandlerContext = {
      organizationId: tenant.organization.id,
      branchId: null,
      jobId: crypto.randomUUID(),
      workerId: "workflow-test",
      attempt: 1,
      correlationId: event.correlationId,
      causationId: event.eventId,
    };
    const execute = async () =>
      database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
        await transaction.execute(
          sql`SELECT set_config('app.current_organization_id', ${tenant.organization.id}, true)`,
        );
        await transaction.execute(
          sql`SELECT set_config('app.current_user_id', ${tenant.user.id}, true)`,
        );
        activeTransaction.current =
          transaction as unknown as OrganizationTransaction;
        try {
          await workflowJob.execute(
            activeTransaction.current,
            jobPayload,
            jobContext,
          );
        } finally {
          activeTransaction.current = null;
        }
      });

    await execute();
    await execute();

    const notifications = await database
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.organizationId, tenant.organization.id));
    const [actionStatus] = await database
      .select({ status: schema.workflowExecutionActions.status })
      .from(schema.workflowExecutionActions)
      .where(
        and(
          eq(
            schema.workflowExecutionActions.organizationId,
            tenant.organization.id,
          ),
          eq(
            schema.workflowExecutionActions.executionId,
            jobPayload.executionId,
          ),
        ),
      );
    const [execution] = await database
      .select({ status: schema.workflowExecutions.status })
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, jobPayload.executionId));
    expect(notifications).toHaveLength(1);
    expect(actionStatus?.status).toBe("SUCCEEDED");
    expect(execution?.status).toBe("SUCCEEDED");
  });
});
