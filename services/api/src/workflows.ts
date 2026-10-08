import {
  loadOrganizationModuleAccess,
  resourceScopePredicate,
  workflowActions,
  workflowDefinitions,
  workflowExecutionActions,
  workflowExecutions,
  workflowSteps,
  workflowVersions,
  type AuthorizationContext,
  type AuthorizationService,
} from "@onecore/database";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const executionPathSchema = organizationPathSchema.extend({
  executionId: z.uuid(),
});
const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const readPermission = "core.organization.workflows.read";

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: {
  auth: AuthorizationContext | null;
}): AuthorizationContext | null {
  return request.auth;
}

function denied(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  statusCode: 401 | 403,
) {
  return reply.status(statusCode).send({
    error: {
      code: statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      message:
        statusCode === 401
          ? "Authentication is required."
          : "The request is not authorized.",
    },
  });
}

function sendResponse(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  response: OperationResponse,
) {
  return reply.status(response.statusCode).send(response.body);
}

function notFound(): OperationResponse {
  return {
    statusCode: 404,
    body: {
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    },
  };
}

function moduleEntitlementDenied(): OperationResponse {
  return {
    statusCode: 403,
    body: {
      error: {
        code: "FORBIDDEN",
        message: "The request is not authorized.",
      },
    },
  };
}

async function hasWorkflowEntitlement(
  transaction: Parameters<
    Parameters<AuthorizationService["withPermission"]>[3]
  >[0],
  organizationId: string,
): Promise<boolean> {
  const access = await loadOrganizationModuleAccess(
    transaction,
    organizationId,
  );
  return access.get("core.configuration")?.allowed === true;
}

export function registerWorkflowRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService,
): void {
  app.get(
    "/organizations/:organizationId/workflow-executions",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const query = paginationSchema.safeParse(request.query);
      if (!path.success || !query.success)
        return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        readPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          if (
            !(await hasWorkflowEntitlement(transaction, context.organizationId))
          ) {
            return moduleEntitlementDenied();
          }
          const scope = resourceScopePredicate(context, readPermission, {
            organizationId: workflowExecutions.organizationId,
            branchId: workflowExecutions.branchId,
          });
          if (!scope) return moduleEntitlementDenied();
          const rows = await transaction
            .select({
              id: workflowExecutions.id,
              workflowName: workflowDefinitions.name,
              workflowKey: workflowDefinitions.key,
              version: workflowVersions.version,
              eventType: workflowExecutions.resourceType,
              status: workflowExecutions.status,
              startedAt: workflowExecutions.startedAt,
              completedAt: workflowExecutions.completedAt,
              failureCode: workflowExecutions.failureCode,
            })
            .from(workflowExecutions)
            .innerJoin(
              workflowVersions,
              and(
                eq(
                  workflowVersions.organizationId,
                  workflowExecutions.organizationId,
                ),
                eq(workflowVersions.id, workflowExecutions.workflowVersionId),
              ),
            )
            .innerJoin(
              workflowDefinitions,
              and(
                eq(
                  workflowDefinitions.organizationId,
                  workflowVersions.organizationId,
                ),
                eq(workflowDefinitions.id, workflowVersions.workflowId),
              ),
            )
            .where(
              and(
                scope,
                eq(workflowExecutions.organizationId, context.organizationId),
              ),
            )
            .orderBy(
              desc(workflowExecutions.startedAt),
              desc(workflowExecutions.id),
            )
            .limit(query.data.limit)
            .offset(query.data.offset);
          const ids = rows.map(({ id }) => id);
          const actionRows = ids.length
            ? await transaction
                .select({
                  executionId: workflowExecutionActions.executionId,
                  type: workflowActions.actionType,
                  position: workflowActions.position,
                  status: workflowExecutionActions.status,
                  startedAt: workflowExecutionActions.startedAt,
                  completedAt: workflowExecutionActions.completedAt,
                  failureCode: workflowExecutionActions.failureCode,
                })
                .from(workflowExecutionActions)
                .innerJoin(
                  workflowActions,
                  and(
                    eq(
                      workflowActions.organizationId,
                      workflowExecutionActions.organizationId,
                    ),
                    eq(
                      workflowActions.id,
                      workflowExecutionActions.workflowActionId,
                    ),
                  ),
                )
                .innerJoin(
                  workflowSteps,
                  and(
                    eq(
                      workflowSteps.organizationId,
                      workflowActions.organizationId,
                    ),
                    eq(workflowSteps.id, workflowActions.workflowStepId),
                  ),
                )
                .where(
                  and(
                    eq(
                      workflowExecutionActions.organizationId,
                      context.organizationId,
                    ),
                    inArray(workflowExecutionActions.executionId, ids),
                  ),
                )
                .orderBy(
                  asc(workflowSteps.position),
                  asc(workflowActions.position),
                )
            : [];
          const actionsByExecution = new Map<string, typeof actionRows>();
          for (const action of actionRows) {
            const existing = actionsByExecution.get(action.executionId) ?? [];
            existing.push(action);
            actionsByExecution.set(action.executionId, existing);
          }
          return {
            statusCode: 200,
            body: {
              executions: rows.map((execution) => ({
                ...execution,
                actions: (actionsByExecution.get(execution.id) ?? []).map(
                  (action) => ({
                    type: action.type,
                    position: action.position,
                    status: action.status,
                    startedAt: action.startedAt,
                    completedAt: action.completedAt,
                    failureCode: action.failureCode,
                  }),
                ),
              })),
            },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/workflow-executions/:executionId",
    async (request, reply) => {
      const path = executionPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        readPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          if (
            !(await hasWorkflowEntitlement(transaction, context.organizationId))
          ) {
            return moduleEntitlementDenied();
          }
          const scope = resourceScopePredicate(context, readPermission, {
            organizationId: workflowExecutions.organizationId,
            branchId: workflowExecutions.branchId,
          });
          if (!scope) return notFound();
          const [execution] = await transaction
            .select({
              id: workflowExecutions.id,
              workflowName: workflowDefinitions.name,
              workflowKey: workflowDefinitions.key,
              version: workflowVersions.version,
              eventType: workflowExecutions.resourceType,
              status: workflowExecutions.status,
              startedAt: workflowExecutions.startedAt,
              completedAt: workflowExecutions.completedAt,
              failureCode: workflowExecutions.failureCode,
            })
            .from(workflowExecutions)
            .innerJoin(
              workflowVersions,
              and(
                eq(
                  workflowVersions.organizationId,
                  workflowExecutions.organizationId,
                ),
                eq(workflowVersions.id, workflowExecutions.workflowVersionId),
              ),
            )
            .innerJoin(
              workflowDefinitions,
              and(
                eq(
                  workflowDefinitions.organizationId,
                  workflowVersions.organizationId,
                ),
                eq(workflowDefinitions.id, workflowVersions.workflowId),
              ),
            )
            .where(
              and(
                scope,
                eq(workflowExecutions.organizationId, context.organizationId),
                eq(workflowExecutions.id, path.data.executionId),
              ),
            )
            .limit(1);
          if (!execution) return notFound();
          const actionStatus = await transaction
            .select({
              type: workflowActions.actionType,
              position: workflowActions.position,
              status: workflowExecutionActions.status,
              startedAt: workflowExecutionActions.startedAt,
              completedAt: workflowExecutionActions.completedAt,
              failureCode: workflowExecutionActions.failureCode,
            })
            .from(workflowExecutionActions)
            .innerJoin(
              workflowActions,
              and(
                eq(
                  workflowActions.organizationId,
                  workflowExecutionActions.organizationId,
                ),
                eq(
                  workflowActions.id,
                  workflowExecutionActions.workflowActionId,
                ),
              ),
            )
            .innerJoin(
              workflowSteps,
              and(
                eq(
                  workflowSteps.organizationId,
                  workflowActions.organizationId,
                ),
                eq(workflowSteps.id, workflowActions.workflowStepId),
              ),
            )
            .where(
              and(
                eq(
                  workflowExecutionActions.organizationId,
                  context.organizationId,
                ),
                eq(workflowExecutionActions.executionId, path.data.executionId),
              ),
            )
            .orderBy(
              asc(workflowSteps.position),
              asc(workflowActions.position),
            );
          return {
            statusCode: 200,
            body: { execution: { ...execution, actions: actionStatus } },
          };
        },
      );
      if (!result.allowed) return denied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );
}
