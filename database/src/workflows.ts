import { createHash, randomUUID } from "node:crypto";
import {
  createDomainEvent,
  eventRegistry,
  evaluateWorkflowCondition,
  parseDomainEvent,
  workflowConditionSchema,
  validateWorkflowTriggerPayload,
  workflowNotificationActionSchema,
  workflowTriggerConfigurationSchema,
  workflowTriggerEventTypes,
  workflowTriggerEventTypeSchema,
} from "@onecore/core-domain";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type {
  AuthorizationContext,
  AuthorizationMetadata,
  AuthorizationService,
} from "./authorization.js";
import { withOrganizationTransaction } from "./tenant-context.js";
import type { Database, OrganizationTransaction } from "./index.js";
import {
  auditLogs,
  jobs,
  outboxEvents,
  workflowActions,
  workflowConditions,
  workflowDefinitions,
  workflowExecutionActions,
  workflowExecutions,
  workflowSteps,
  workflowTransitions,
  workflowTriggers,
  workflowVersions,
} from "../schema/index.js";
import { EventDispatchError, type EventHandler } from "./event-dispatcher.js";
import {
  JobExecutionError,
  type JobHandler,
  type JobHandlerContext,
} from "./jobs.js";
import { createInAppNotificationInTransaction } from "./platform-services.js";
import { recordOutboxEvent } from "./outbox.js";

const workflowPermission = "core.organization.workflows.manage";
const notificationPermission = "core.organization.notification_inbox.manage";
const workflowJobType = "core.workflow.execute";
const workflowJobMaxAttempts = 5;

const workflowJobPayloadSchema = z
  .object({
    executionId: z.uuid(),
    eventId: z.uuid(),
    principal: z
      .object({
        userId: z.uuid(),
        sessionId: z.uuid(),
        organizationId: z.uuid(),
        membershipId: z.uuid(),
        branchId: z.uuid().nullable(),
      })
      .strict(),
  })
  .strict();
export type WorkflowJobPayload = z.infer<typeof workflowJobPayloadSchema>;

export async function validateWorkflowVersionForExecution(
  transaction: OrganizationTransaction,
  organizationId: string,
  workflowVersionId: string,
): Promise<void> {
  const [triggers, steps, conditions, transitions, actions] = await Promise.all(
    [
      transaction
        .select({
          triggerType: workflowTriggers.triggerType,
          configuration: workflowTriggers.configuration,
        })
        .from(workflowTriggers)
        .where(
          and(
            eq(workflowTriggers.organizationId, organizationId),
            eq(workflowTriggers.workflowVersionId, workflowVersionId),
          ),
        ),
      transaction
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.organizationId, organizationId),
            eq(workflowSteps.workflowVersionId, workflowVersionId),
          ),
        ),
      transaction
        .select({
          workflowStepId: workflowConditions.workflowStepId,
          expression: workflowConditions.expression,
        })
        .from(workflowConditions)
        .innerJoin(
          workflowSteps,
          and(
            eq(workflowSteps.organizationId, workflowConditions.organizationId),
            eq(workflowSteps.id, workflowConditions.workflowStepId),
            eq(workflowSteps.workflowVersionId, workflowVersionId),
          ),
        )
        .where(eq(workflowConditions.organizationId, organizationId)),
      transaction
        .select({
          fromStepId: workflowTransitions.fromStepId,
          toStepId: workflowTransitions.toStepId,
          condition: workflowTransitions.condition,
        })
        .from(workflowTransitions)
        .where(
          and(
            eq(workflowTransitions.organizationId, organizationId),
            eq(workflowTransitions.workflowVersionId, workflowVersionId),
          ),
        ),
      transaction
        .select({
          actionType: workflowActions.actionType,
          configuration: workflowActions.configuration,
        })
        .from(workflowActions)
        .innerJoin(
          workflowSteps,
          and(
            eq(workflowSteps.organizationId, workflowActions.organizationId),
            eq(workflowSteps.id, workflowActions.workflowStepId),
            eq(workflowSteps.workflowVersionId, workflowVersionId),
          ),
        )
        .where(eq(workflowActions.organizationId, organizationId)),
    ],
  );

  if (
    triggers.length < 1 ||
    triggers.length > 50 ||
    steps.length < 1 ||
    steps.length > 100 ||
    conditions.length > 250 ||
    transitions.length > 500 ||
    actions.length < 1 ||
    actions.length > 250
  ) {
    throw new TypeError("WORKFLOW_CONFIGURATION_LIMIT_INVALID");
  }
  const triggerTypes = triggers.map(({ triggerType, configuration }) => {
    const parsedType = workflowTriggerEventTypeSchema.parse(triggerType);
    workflowTriggerConfigurationSchema.parse(configuration);
    return parsedType;
  });
  const fields = new Set<string>();
  for (const condition of conditions) {
    fields.add(workflowConditionSchema.parse(condition.expression).field);
  }
  for (const transition of transitions) {
    const value = conditionValue(transition.condition);
    if (Object.keys(value).length > 0) {
      fields.add(workflowConditionSchema.parse(value).field);
    }
  }
  for (const triggerType of triggerTypes) {
    const payloadShape = eventRegistry[triggerType].payloadSchema.shape;
    for (const field of fields) {
      if (!Object.hasOwn(payloadShape, field)) {
        throw new TypeError("WORKFLOW_CONDITION_FIELD_UNAVAILABLE");
      }
    }
  }
  if (transitions.length > 0) {
    const stepIds = new Set(steps.map(({ id }) => id));
    const indegree = new Map(steps.map(({ id }) => [id, 0]));
    const outgoing = new Map<string, string[]>();
    for (const transition of transitions) {
      if (
        !stepIds.has(transition.fromStepId) ||
        !stepIds.has(transition.toStepId) ||
        transition.fromStepId === transition.toStepId
      ) {
        throw new TypeError("WORKFLOW_GRAPH_INVALID");
      }
      indegree.set(
        transition.toStepId,
        (indegree.get(transition.toStepId) ?? 0) + 1,
      );
      const targets = outgoing.get(transition.fromStepId) ?? [];
      targets.push(transition.toStepId);
      outgoing.set(transition.fromStepId, targets);
    }
    const roots = [...indegree]
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id);
    if (roots.length !== 1) throw new TypeError("WORKFLOW_GRAPH_INVALID");
    const pending = [...roots];
    let processed = 0;
    while (pending.length > 0) {
      const stepId = pending.pop();
      if (!stepId) continue;
      processed += 1;
      for (const targetId of outgoing.get(stepId) ?? []) {
        const remaining = (indegree.get(targetId) ?? 0) - 1;
        indegree.set(targetId, remaining);
        if (remaining === 0) pending.push(targetId);
      }
    }
    if (processed !== steps.length)
      throw new TypeError("WORKFLOW_GRAPH_INVALID");
  }
  for (const action of actions) {
    if (action.actionType !== "NOTIFICATION") {
      throw new TypeError("WORKFLOW_ACTION_NOT_SUPPORTED");
    }
    const config = workflowNotificationActionSchema.parse(action.configuration);
    if (
      config.recipient.type === "PAYLOAD_USER_ID" &&
      triggerTypes.some(
        (triggerType) =>
          !Object.hasOwn(
            eventRegistry[triggerType].payloadSchema.shape,
            "userId",
          ),
      )
    ) {
      throw new TypeError("WORKFLOW_RECIPIENT_FIELD_UNAVAILABLE");
    }
  }
}

function safeEventPayload(
  eventType: string,
  payload: unknown,
): Record<string, unknown> {
  const parsedType = workflowTriggerEventTypeSchema.safeParse(eventType);
  if (!parsedType.success) {
    throw new JobExecutionError("WORKFLOW_EVENT_NOT_SUPPORTED", false);
  }
  try {
    return validateWorkflowTriggerPayload(parsedType.data, payload);
  } catch {
    throw new JobExecutionError("WORKFLOW_EVENT_INVALID", false);
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jobKey(executionId: string): string {
  return `workflow-execution:${executionId}`;
}

async function updateExecutionFailure(
  database: Database,
  organizationId: string,
  executionId: string,
  actionId: string | null,
  failureCode: string,
  terminal: boolean,
): Promise<void> {
  await withOrganizationTransaction(database, organizationId, async (tx) => {
    const now = new Date();
    const activeStatuses = inArray(workflowExecutionActions.status, [
      "PENDING",
      "RUNNING",
      "RETRYING",
    ]);
    if (actionId || terminal) {
      await tx
        .update(workflowExecutionActions)
        .set({
          status: terminal ? "FAILED" : "RETRYING",
          failureCode,
          completedAt: terminal ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(workflowExecutionActions.organizationId, organizationId),
            eq(workflowExecutionActions.executionId, executionId),
            activeStatuses,
            actionId
              ? eq(workflowExecutionActions.workflowActionId, actionId)
              : activeStatuses,
          ),
        );
    }
    if (terminal && actionId) {
      await tx
        .update(workflowExecutionActions)
        .set({
          status: "SKIPPED",
          failureCode: "WORKFLOW_ABORTED",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workflowExecutionActions.organizationId, organizationId),
            eq(workflowExecutionActions.executionId, executionId),
            activeStatuses,
            ne(workflowExecutionActions.workflowActionId, actionId),
          ),
        );
    }
    await tx
      .update(workflowExecutions)
      .set({
        status: terminal ? "FAILED" : "RETRYING",
        failureCode,
        completedAt: terminal ? now : null,
      })
      .where(
        and(
          eq(workflowExecutions.organizationId, organizationId),
          eq(workflowExecutions.id, executionId),
        ),
      );
    await tx.insert(auditLogs).values({
      organizationId,
      actorUserId: null,
      action: terminal
        ? "WORKFLOW_EXECUTION_FAILED"
        : "WORKFLOW_EXECUTION_RETRYING",
      resource: "workflow_execution",
      resourceId: executionId,
      result: terminal ? "FAILURE" : "SUCCESS",
      requestMetadata: { actionId, failureCode },
    });
  });
}

async function auditWorkflowExecution(
  transaction: OrganizationTransaction,
  organizationId: string,
  executionId: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId,
    actorUserId: null,
    action,
    resource: "workflow_execution",
    resourceId: executionId,
    result: action.endsWith("_FAILED") ? "FAILURE" : "SUCCESS",
    requestMetadata: details,
  });
}

export function createWorkflowEventHandlers(): EventHandler[] {
  return workflowTriggerEventTypes.map((eventType) => ({
    handlerName: `core.workflow.trigger.${eventType.toLowerCase()}`,
    eventType,
    eventVersion: eventRegistry[eventType].version,
    owningModule: "core.configuration",
    requiredModuleEntitlement: "core.configuration",
    requiredPermissionKey: workflowPermission,
    async handle(transaction, event, context) {
      if (
        context.organizationId !== event.organizationId ||
        context.branchId !== (event.branchId ?? null)
      ) {
        throw new EventDispatchError(
          "AUTHORIZATION_FAILURE",
          "WORKFLOW_EVENT_SCOPE_MISMATCH",
          false,
        );
      }
      const matching = await transaction
        .select({
          workflowId: workflowDefinitions.id,
          workflowVersionId: workflowVersions.id,
        })
        .from(workflowDefinitions)
        .innerJoin(
          workflowVersions,
          and(
            eq(
              workflowVersions.organizationId,
              workflowDefinitions.organizationId,
            ),
            eq(workflowVersions.workflowId, workflowDefinitions.id),
            eq(workflowVersions.status, "PUBLISHED"),
          ),
        )
        .innerJoin(
          workflowTriggers,
          and(
            eq(
              workflowTriggers.organizationId,
              workflowVersions.organizationId,
            ),
            eq(workflowTriggers.workflowVersionId, workflowVersions.id),
            eq(workflowTriggers.triggerType, event.eventType),
          ),
        )
        .where(
          and(
            eq(workflowDefinitions.organizationId, context.organizationId),
            eq(workflowDefinitions.status, "ACTIVE"),
          ),
        )
        .orderBy(asc(workflowDefinitions.id));
      if (matching.length > 100) {
        throw new EventDispatchError(
          "HANDLER_FAILURE",
          "WORKFLOW_FANOUT_LIMIT_EXCEEDED",
          false,
        );
      }

      for (const candidate of matching) {
        const executionId = randomUUID();
        const insertedExecution = await transaction
          .insert(workflowExecutions)
          .values({
            id: executionId,
            organizationId: context.organizationId,
            workflowVersionId: candidate.workflowVersionId,
            sourceEventId: event.eventId,
            branchId: event.branchId ?? null,
            status: "PENDING",
            resourceType: event.eventType,
            resourceId: event.aggregateId,
            context: { eventVersion: event.eventVersion },
          })
          .onConflictDoNothing()
          .returning({ id: workflowExecutions.id });
        if (!insertedExecution.length) continue;
        await transaction.insert(auditLogs).values({
          organizationId: context.organizationId,
          actorUserId: context.userId,
          action: "WORKFLOW_EXECUTION_CREATED",
          resource: "workflow_execution",
          resourceId: executionId,
          result: "SUCCESS",
          requestMetadata: {
            eventId: event.eventId,
            eventType: event.eventType,
            workflowVersionId: candidate.workflowVersionId,
          },
        });

        const steps = await transaction
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.organizationId, context.organizationId),
              eq(workflowSteps.workflowVersionId, candidate.workflowVersionId),
            ),
          );
        const actions = steps.length
          ? await transaction
              .select({ id: workflowActions.id })
              .from(workflowActions)
              .where(
                and(
                  eq(workflowActions.organizationId, context.organizationId),
                  inArray(
                    workflowActions.workflowStepId,
                    steps.map(({ id }) => id),
                  ),
                ),
              )
          : [];
        if (actions.length) {
          await transaction.insert(workflowExecutionActions).values(
            actions.map(({ id }) => ({
              organizationId: context.organizationId,
              executionId,
              workflowActionId: id,
            })),
          );
        }

        const payload: WorkflowJobPayload = {
          executionId,
          eventId: event.eventId,
          principal: {
            userId: context.userId,
            sessionId: context.sessionId,
            organizationId: context.organizationId,
            membershipId: context.membershipId,
            branchId: context.branchId,
          },
        };
        const idempotencyKey = jobKey(executionId);
        const [job] = await transaction
          .insert(jobs)
          .values({
            organizationId: context.organizationId,
            branchId: event.branchId ?? null,
            createdByUserId: context.userId,
            jobType: workflowJobType,
            payload,
            idempotencyKey,
            requestHash: stableHash(payload),
            correlationId: event.correlationId,
            causationId: event.eventId,
            maxAttempts: workflowJobMaxAttempts,
          })
          .returning({ id: jobs.id });
        if (!job) throw new Error("WORKFLOW_JOB_CREATE_FAILED");
        await transaction.insert(auditLogs).values({
          organizationId: context.organizationId,
          actorUserId: context.userId,
          action: "JOB_ENQUEUED",
          resource: "job",
          resourceId: job.id,
          result: "SUCCESS",
          requestMetadata: {
            jobType: workflowJobType,
            workflowExecutionId: executionId,
            correlationId: event.correlationId,
          },
        });
        await recordOutboxEvent(
          transaction,
          createDomainEvent({
            eventType: "JOB_ENQUEUED",
            organizationId: context.organizationId,
            ...(event.branchId ? { branchId: event.branchId } : {}),
            actorUserId: context.userId,
            correlationId: event.correlationId,
            causationId: event.eventId,
            aggregateType: "platform_job",
            aggregateId: job.id,
            payload: { jobId: job.id, jobType: workflowJobType },
            metadata: {},
          }),
        );
      }
    },
  }));
}

interface WorkflowActionSpec {
  actionId: string;
  stepId: string;
  stepPosition: number;
  actionPosition: number;
  actionType: string;
  configuration: unknown;
}

function conditionValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JobExecutionError("WORKFLOW_CONDITION_INVALID", false);
  }
  return value as Record<string, unknown>;
}

function transitionAllows(
  condition: unknown,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const parsed = conditionValue(condition);
  if (Object.keys(parsed).length === 0) return true;
  try {
    return evaluateWorkflowCondition(parsed, payload);
  } catch {
    throw new JobExecutionError("WORKFLOW_CONDITION_INVALID", false);
  }
}

function resolveActiveSteps(
  steps: { id: string; position: number }[],
  transitions: {
    fromStepId: string;
    toStepId: string;
    condition: unknown;
  }[],
  conditions: { workflowStepId: string; expression: unknown }[],
  payload: Readonly<Record<string, unknown>>,
): Set<string> {
  const ordered = [...steps].sort(
    (left, right) =>
      left.position - right.position || left.id.localeCompare(right.id),
  );
  if (transitions.length === 0) {
    const active = new Set<string>();
    for (const step of ordered) {
      if (
        conditions
          .filter((condition) => condition.workflowStepId === step.id)
          .every((condition) => {
            try {
              return evaluateWorkflowCondition(condition.expression, payload);
            } catch {
              throw new JobExecutionError("WORKFLOW_CONDITION_INVALID", false);
            }
          })
      ) {
        active.add(step.id);
      }
    }
    return active;
  }

  const incoming = new Map<string, typeof transitions>();
  const outgoing = new Map<string, typeof transitions>();
  for (const transition of transitions) {
    const inRows = incoming.get(transition.toStepId) ?? [];
    inRows.push(transition);
    incoming.set(transition.toStepId, inRows);
    const outRows = outgoing.get(transition.fromStepId) ?? [];
    outRows.push(transition);
    outgoing.set(transition.fromStepId, outRows);
  }
  const stepById = new Map(ordered.map((step) => [step.id, step]));
  const roots = ordered.filter((step) => !incoming.has(step.id));
  if (roots.length !== 1) {
    throw new JobExecutionError("WORKFLOW_GRAPH_INVALID", false);
  }
  const indegrees = new Map(ordered.map((step) => [step.id, 0]));
  for (const transition of transitions) {
    if (
      !stepById.has(transition.fromStepId) ||
      !stepById.has(transition.toStepId) ||
      transition.fromStepId === transition.toStepId
    ) {
      throw new JobExecutionError("WORKFLOW_GRAPH_INVALID", false);
    }
    indegrees.set(
      transition.toStepId,
      (indegrees.get(transition.toStepId) ?? 0) + 1,
    );
  }
  const topological: string[] = [];
  const ready = roots.map(({ id }) => id);
  while (ready.length) {
    ready.sort((left, right) => {
      const leftStep = stepById.get(left);
      const rightStep = stepById.get(right);
      return (
        (leftStep?.position ?? 0) - (rightStep?.position ?? 0) ||
        left.localeCompare(right)
      );
    });
    const id = ready.shift();
    if (!id) continue;
    topological.push(id);
    for (const transition of outgoing.get(id) ?? []) {
      const remaining = (indegrees.get(transition.toStepId) ?? 0) - 1;
      indegrees.set(transition.toStepId, remaining);
      if (remaining === 0) ready.push(transition.toStepId);
    }
  }
  if (topological.length !== ordered.length) {
    throw new JobExecutionError("WORKFLOW_GRAPH_INVALID", false);
  }

  const active = new Set<string>();
  for (const stepId of topological) {
    const parents = incoming.get(stepId) ?? [];
    const triggered =
      parents.length === 0 ||
      parents.some(
        (transition) =>
          active.has(transition.fromStepId) &&
          transitionAllows(transition.condition, payload),
      );
    if (!triggered) continue;
    const passes = conditions
      .filter((condition) => condition.workflowStepId === stepId)
      .every((condition) => {
        try {
          return evaluateWorkflowCondition(condition.expression, payload);
        } catch {
          throw new JobExecutionError("WORKFLOW_CONDITION_INVALID", false);
        }
      });
    if (passes) active.add(stepId);
  }
  return active;
}

function workflowAuthorizationContext(
  payload: WorkflowJobPayload,
): AuthorizationContext {
  return {
    userId: payload.principal.userId,
    sessionId: payload.principal.sessionId,
    organizationId: payload.principal.organizationId,
    membershipId: payload.principal.membershipId,
    branchId: payload.principal.branchId,
  };
}

async function loadWorkflowPlan(
  transaction: OrganizationTransaction,
  payload: WorkflowJobPayload,
  jobContext: JobHandlerContext,
) {
  const [execution] = await transaction
    .select({
      id: workflowExecutions.id,
      organizationId: workflowExecutions.organizationId,
      workflowVersionId: workflowExecutions.workflowVersionId,
      sourceEventId: workflowExecutions.sourceEventId,
      branchId: workflowExecutions.branchId,
      status: workflowExecutions.status,
      definitionStatus: workflowDefinitions.status,
      versionStatus: workflowVersions.status,
    })
    .from(workflowExecutions)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.organizationId, workflowExecutions.organizationId),
        eq(workflowVersions.id, workflowExecutions.workflowVersionId),
      ),
    )
    .innerJoin(
      workflowDefinitions,
      and(
        eq(workflowDefinitions.organizationId, workflowVersions.organizationId),
        eq(workflowDefinitions.id, workflowVersions.workflowId),
      ),
    )
    .where(
      and(
        eq(workflowExecutions.organizationId, jobContext.organizationId),
        eq(workflowExecutions.id, payload.executionId),
        eq(workflowExecutions.sourceEventId, payload.eventId),
      ),
    )
    .limit(1);
  if (!execution)
    throw new JobExecutionError("WORKFLOW_EXECUTION_NOT_FOUND", false);
  if (
    execution.organizationId !== payload.principal.organizationId ||
    execution.branchId !== jobContext.branchId ||
    execution.sourceEventId !== payload.eventId
  ) {
    throw new JobExecutionError("WORKFLOW_EXECUTION_SCOPE_INVALID", false);
  }
  if (["SUCCEEDED", "FAILED", "SKIPPED"].includes(execution.status)) {
    return {
      execution,
      event: null,
      eventPayload: {},
      skip: true as const,
      actions: [] as WorkflowActionSpec[],
      activeSteps: new Set<string>(),
    };
  }

  const [eventRow] = await transaction
    .select({
      id: outboxEvents.id,
      eventType: outboxEvents.eventType,
      eventVersion: outboxEvents.version,
      occurredAt: outboxEvents.occurredAt,
      organizationId: outboxEvents.organizationId,
      branchId: outboxEvents.branchId,
      actorUserId: outboxEvents.actorUserId,
      correlationId: outboxEvents.correlationId,
      causationId: outboxEvents.causationId,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      payload: outboxEvents.payload,
      metadata: outboxEvents.metadata,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.organizationId, jobContext.organizationId),
        eq(outboxEvents.id, payload.eventId),
      ),
    )
    .limit(1);
  if (!eventRow) throw new JobExecutionError("WORKFLOW_EVENT_NOT_FOUND", false);
  if (eventRow.organizationId !== jobContext.organizationId) {
    throw new JobExecutionError("WORKFLOW_EVENT_SCOPE_INVALID", false);
  }
  let event;
  try {
    event = parseDomainEvent({
      eventId: eventRow.id,
      eventType: eventRow.eventType,
      eventVersion: eventRow.eventVersion,
      occurredAt: eventRow.occurredAt,
      organizationId: eventRow.organizationId,
      ...(eventRow.branchId ? { branchId: eventRow.branchId } : {}),
      ...(eventRow.actorUserId ? { actorUserId: eventRow.actorUserId } : {}),
      correlationId: eventRow.correlationId,
      ...(eventRow.causationId ? { causationId: eventRow.causationId } : {}),
      aggregateType: eventRow.aggregateType,
      aggregateId: eventRow.aggregateId,
      payload: eventRow.payload,
      metadata: eventRow.metadata,
    });
  } catch {
    throw new JobExecutionError("WORKFLOW_EVENT_INVALID", false);
  }
  const triggerEventType = workflowTriggerEventTypeSchema.safeParse(
    event.eventType,
  );
  if (!triggerEventType.success) {
    throw new JobExecutionError("WORKFLOW_EVENT_NOT_SUPPORTED", false);
  }
  const eventPayload = safeEventPayload(event.eventType, event.payload);
  if (
    execution.definitionStatus !== "ACTIVE" ||
    execution.versionStatus !== "PUBLISHED"
  ) {
    return {
      execution,
      event,
      eventPayload,
      skip: true as const,
      actions: [] as WorkflowActionSpec[],
      activeSteps: new Set<string>(),
    };
  }

  const triggers = await transaction
    .select({
      id: workflowTriggers.id,
      configuration: workflowTriggers.configuration,
    })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.organizationId, jobContext.organizationId),
        eq(workflowTriggers.workflowVersionId, execution.workflowVersionId),
        eq(workflowTriggers.triggerType, event.eventType),
      ),
    );
  if (triggers.length === 0) {
    throw new JobExecutionError("WORKFLOW_TRIGGER_NOT_FOUND", false);
  }
  for (const trigger of triggers) {
    try {
      workflowTriggerConfigurationSchema.parse(trigger.configuration);
    } catch {
      throw new JobExecutionError("WORKFLOW_TRIGGER_INVALID", false);
    }
  }

  const steps = await transaction
    .select({ id: workflowSteps.id, position: workflowSteps.position })
    .from(workflowSteps)
    .where(
      and(
        eq(workflowSteps.organizationId, jobContext.organizationId),
        eq(workflowSteps.workflowVersionId, execution.workflowVersionId),
      ),
    );
  const stepIds = steps.map(({ id }) => id);
  const [conditions, transitions, actionRows] = await Promise.all([
    stepIds.length
      ? transaction
          .select({
            workflowStepId: workflowConditions.workflowStepId,
            expression: workflowConditions.expression,
          })
          .from(workflowConditions)
          .where(
            and(
              eq(workflowConditions.organizationId, jobContext.organizationId),
              inArray(workflowConditions.workflowStepId, stepIds),
            ),
          )
      : Promise.resolve([]),
    transaction
      .select({
        fromStepId: workflowTransitions.fromStepId,
        toStepId: workflowTransitions.toStepId,
        condition: workflowTransitions.condition,
      })
      .from(workflowTransitions)
      .where(
        and(
          eq(workflowTransitions.organizationId, jobContext.organizationId),
          eq(
            workflowTransitions.workflowVersionId,
            execution.workflowVersionId,
          ),
        ),
      ),
    stepIds.length
      ? transaction
          .select({
            actionId: workflowActions.id,
            stepId: workflowActions.workflowStepId,
            stepPosition: workflowSteps.position,
            actionPosition: workflowActions.position,
            actionType: workflowActions.actionType,
            configuration: workflowActions.configuration,
          })
          .from(workflowActions)
          .innerJoin(
            workflowSteps,
            and(
              eq(workflowSteps.organizationId, workflowActions.organizationId),
              eq(workflowSteps.id, workflowActions.workflowStepId),
            ),
          )
          .where(
            and(
              eq(workflowActions.organizationId, jobContext.organizationId),
              inArray(workflowActions.workflowStepId, stepIds),
            ),
          )
          .orderBy(
            asc(workflowSteps.position),
            asc(workflowActions.position),
            asc(workflowActions.id),
          )
      : Promise.resolve([]),
  ]);

  let activeSteps: Set<string>;
  try {
    activeSteps = resolveActiveSteps(
      steps,
      transitions,
      conditions,
      eventPayload,
    );
  } catch (error) {
    if (error instanceof JobExecutionError) throw error;
    throw new JobExecutionError("WORKFLOW_CONDITION_INVALID", false);
  }
  const actions = actionRows.map((action) => ({
    ...action,
    configuration: action.configuration as unknown,
  }));
  for (const action of actions) {
    if (action.actionType !== "NOTIFICATION") {
      throw new JobExecutionError("WORKFLOW_ACTION_NOT_SUPPORTED", false);
    }
    try {
      workflowNotificationActionSchema.parse(action.configuration);
    } catch {
      throw new JobExecutionError("WORKFLOW_ACTION_INVALID", false);
    }
  }
  return {
    execution,
    event,
    eventPayload,
    skip: false as const,
    actions,
    activeSteps,
  };
}

async function markWorkflowSkipped(
  transaction: OrganizationTransaction,
  organizationId: string,
  executionId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await transaction
    .update(workflowExecutionActions)
    .set({ status: "SKIPPED", completedAt: now, failureCode: reason })
    .where(
      and(
        eq(workflowExecutionActions.organizationId, organizationId),
        eq(workflowExecutionActions.executionId, executionId),
        inArray(workflowExecutionActions.status, [
          "PENDING",
          "RUNNING",
          "RETRYING",
        ]),
      ),
    );
  await transaction
    .update(workflowExecutions)
    .set({ status: "SKIPPED", completedAt: now, failureCode: reason })
    .where(
      and(
        eq(workflowExecutions.organizationId, organizationId),
        eq(workflowExecutions.id, executionId),
        inArray(workflowExecutions.status, ["PENDING", "RUNNING", "RETRYING"]),
      ),
    );
  await transaction.insert(auditLogs).values({
    organizationId,
    actorUserId: null,
    action: "WORKFLOW_EXECUTION_SKIPPED",
    resource: "workflow_execution",
    resourceId: executionId,
    result: "SUCCESS",
    requestMetadata: { reason },
  });
}

export function createWorkflowJobHandler(
  database: Database,
  authorization: AuthorizationService,
): JobHandler<WorkflowJobPayload> {
  return {
    jobType: workflowJobType,
    owningModule: "core.configuration",
    requiredModuleEntitlement: "core.configuration",
    payloadSchema: workflowJobPayloadSchema,
    async execute(transaction, payloadInput, jobContext) {
      const payload = workflowJobPayloadSchema.parse(payloadInput);
      if (
        payload.principal.organizationId !== jobContext.organizationId ||
        payload.principal.branchId !== jobContext.branchId
      ) {
        throw new JobExecutionError("WORKFLOW_JOB_SCOPE_INVALID", false);
      }

      let currentActionId: string | null = null;
      try {
        const plan = await loadWorkflowPlan(transaction, payload, jobContext);
        if (plan.skip) {
          if (plan.event) {
            await markWorkflowSkipped(
              transaction,
              jobContext.organizationId,
              payload.executionId,
              "WORKFLOW_INACTIVE",
            );
          }
          return;
        }

        await transaction
          .update(workflowExecutions)
          .set({ status: "RUNNING", failureCode: null })
          .where(
            and(
              eq(workflowExecutions.organizationId, jobContext.organizationId),
              eq(workflowExecutions.id, payload.executionId),
              inArray(workflowExecutions.status, [
                "PENDING",
                "RETRYING",
                "RUNNING",
              ]),
            ),
          );

        const selectedActions = plan.actions.filter((action) =>
          plan.activeSteps.has(action.stepId),
        );
        const selectedIds = new Set(
          selectedActions.map(({ actionId }) => actionId),
        );
        const skippedRows = plan.actions
          .filter((action) => !selectedIds.has(action.actionId))
          .map(({ actionId }) => ({ workflowActionId: actionId }));
        if (skippedRows.length) {
          const now = new Date();
          for (const action of skippedRows) {
            await transaction
              .update(workflowExecutionActions)
              .set({ status: "SKIPPED", completedAt: now, failureCode: null })
              .where(
                and(
                  eq(
                    workflowExecutionActions.organizationId,
                    jobContext.organizationId,
                  ),
                  eq(workflowExecutionActions.executionId, payload.executionId),
                  eq(
                    workflowExecutionActions.workflowActionId,
                    action.workflowActionId,
                  ),
                  inArray(workflowExecutionActions.status, [
                    "PENDING",
                    "SKIPPED",
                  ]),
                ),
              );
          }
        }

        for (const action of selectedActions) {
          currentActionId = action.actionId;
          const actionConfiguration = workflowNotificationActionSchema.parse(
            action.configuration,
          );
          const recipientUserId =
            actionConfiguration.recipient.type === "ACTOR"
              ? plan.event.actorUserId
              : plan.eventPayload[actionConfiguration.recipient.field];
          if (
            typeof recipientUserId !== "string" ||
            !z.uuid().safeParse(recipientUserId).success
          ) {
            throw new JobExecutionError("WORKFLOW_RECIPIENT_INVALID", false);
          }

          const principal = workflowAuthorizationContext(payload);
          const metadata: AuthorizationMetadata = {
            requestId: `workflow-${payload.executionId}`,
            correlationId: plan.event.correlationId,
          };
          const result = await authorization.withAllPermissions(
            principal,
            [workflowPermission, notificationPermission],
            metadata,
            async (authorizedTransaction, resolved) => {
              const [progress] = await authorizedTransaction
                .select({ status: workflowExecutionActions.status })
                .from(workflowExecutionActions)
                .where(
                  and(
                    eq(
                      workflowExecutionActions.organizationId,
                      jobContext.organizationId,
                    ),
                    eq(
                      workflowExecutionActions.executionId,
                      payload.executionId,
                    ),
                    eq(
                      workflowExecutionActions.workflowActionId,
                      action.actionId,
                    ),
                  ),
                )
                .for("update")
                .limit(1);
              if (!progress) {
                throw new JobExecutionError(
                  "WORKFLOW_ACTION_PROGRESS_MISSING",
                  false,
                );
              }
              if (
                progress.status === "SUCCEEDED" ||
                progress.status === "SKIPPED"
              ) {
                return progress.status;
              }
              const startedAt = new Date();
              await authorizedTransaction
                .update(workflowExecutionActions)
                .set({
                  status: "RUNNING",
                  attempts:
                    (await getActionAttempts(
                      authorizedTransaction,
                      jobContext.organizationId,
                      payload.executionId,
                      action.actionId,
                    )) + 1,
                  startedAt,
                  completedAt: null,
                  failureCode: null,
                  updatedAt: startedAt,
                })
                .where(
                  and(
                    eq(
                      workflowExecutionActions.organizationId,
                      jobContext.organizationId,
                    ),
                    eq(
                      workflowExecutionActions.executionId,
                      payload.executionId,
                    ),
                    eq(
                      workflowExecutionActions.workflowActionId,
                      action.actionId,
                    ),
                  ),
                );
              const notification = await createInAppNotificationInTransaction(
                authorizedTransaction,
                resolved,
                metadata,
                {
                  recipientUserId,
                  notificationType: actionConfiguration.notificationType,
                  title: actionConfiguration.title,
                  body: actionConfiguration.body,
                  metadata: { workflowExecutionId: payload.executionId },
                  ...(plan.event.branchId
                    ? { branchId: plan.event.branchId }
                    : {}),
                },
              );
              const finishedAt = new Date();
              const status = notification ? "SUCCEEDED" : "SKIPPED";
              await authorizedTransaction
                .update(workflowExecutionActions)
                .set({
                  status,
                  completedAt: finishedAt,
                  failureCode: null,
                  updatedAt: finishedAt,
                })
                .where(
                  and(
                    eq(
                      workflowExecutionActions.organizationId,
                      jobContext.organizationId,
                    ),
                    eq(
                      workflowExecutionActions.executionId,
                      payload.executionId,
                    ),
                    eq(
                      workflowExecutionActions.workflowActionId,
                      action.actionId,
                    ),
                  ),
                );
              await authorizedTransaction.insert(auditLogs).values({
                organizationId: jobContext.organizationId,
                actorUserId: resolved.userId,
                action: `WORKFLOW_ACTION_${status}`,
                resource: "workflow_execution",
                resourceId: payload.executionId,
                result: "SUCCESS",
                requestMetadata: {
                  actionId: action.actionId,
                  actionType: "NOTIFICATION",
                },
              });
              return status;
            },
          );

          if (!result.allowed) {
            const code = "WORKFLOW_ACTION_AUTHORIZATION_FAILED";
            const terminal = true;
            await updateExecutionFailure(
              database,
              jobContext.organizationId,
              payload.executionId,
              action.actionId,
              code,
              terminal,
            );
            throw new JobExecutionError(code, false);
          }
        }

        const [remaining] = await transaction
          .select({ count: workflowExecutionActions.id })
          .from(workflowExecutionActions)
          .where(
            and(
              eq(
                workflowExecutionActions.organizationId,
                jobContext.organizationId,
              ),
              eq(workflowExecutionActions.executionId, payload.executionId),
              inArray(workflowExecutionActions.status, [
                "PENDING",
                "RUNNING",
                "RETRYING",
              ]),
            ),
          )
          .limit(1);
        if (remaining) {
          throw new JobExecutionError("WORKFLOW_ACTIONS_INCOMPLETE", true);
        }
        const now = new Date();
        await transaction
          .update(workflowExecutions)
          .set({ status: "SUCCEEDED", completedAt: now, failureCode: null })
          .where(
            and(
              eq(workflowExecutions.organizationId, jobContext.organizationId),
              eq(workflowExecutions.id, payload.executionId),
            ),
          );
        await auditWorkflowExecution(
          transaction,
          jobContext.organizationId,
          payload.executionId,
          "WORKFLOW_EXECUTION_SUCCEEDED",
          {
            eventType: plan.event.eventType,
            actionCount: selectedActions.length,
            skippedActionCount: skippedRows.length,
          },
        );
      } catch (error) {
        const failure =
          error instanceof JobExecutionError
            ? error
            : new JobExecutionError("WORKFLOW_ACTION_FAILED", true);
        await updateExecutionFailure(
          database,
          jobContext.organizationId,
          payload.executionId,
          currentActionId,
          failure.code,
          !failure.retryable || jobContext.attempt >= workflowJobMaxAttempts,
        );
        throw failure;
      }
    },
  };
}

async function getActionAttempts(
  transaction: OrganizationTransaction,
  organizationId: string,
  executionId: string,
  actionId: string,
): Promise<number> {
  const [row] = await transaction
    .select({ attempts: workflowExecutionActions.attempts })
    .from(workflowExecutionActions)
    .where(
      and(
        eq(workflowExecutionActions.organizationId, organizationId),
        eq(workflowExecutionActions.executionId, executionId),
        eq(workflowExecutionActions.workflowActionId, actionId),
      ),
    )
    .limit(1);
  return row?.attempts ?? 0;
}
