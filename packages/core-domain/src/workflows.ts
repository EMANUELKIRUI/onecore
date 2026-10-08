import { z } from "zod";
import { eventRegistry, type EventType } from "./events.js";

export const workflowTriggerEventTypes = [
  "ORGANIZATION_CREATED",
  "ORGANIZATION_ACTIVATED",
  "USER_CREATED",
  "USER_INVITED",
  "USER_ROLE_CHANGED",
  "MODULE_ENABLED",
  "MODULE_DISABLED",
  "CONFIGURATION_CHANGED",
  "FEATURE_FLAG_CHANGED",
] as const satisfies readonly EventType[];

export const workflowTriggerEventTypeSchema = z.enum(workflowTriggerEventTypes);
export type WorkflowTriggerEventType = z.infer<
  typeof workflowTriggerEventTypeSchema
>;

export const workflowExecutionStatuses = [
  "PENDING",
  "RUNNING",
  "RETRYING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
] as const;
export const workflowExecutionStatusSchema = z.enum(workflowExecutionStatuses);
export type WorkflowExecutionStatus = z.infer<
  typeof workflowExecutionStatusSchema
>;

export const workflowActionStatuses = workflowExecutionStatuses;
export const workflowActionStatusSchema = workflowExecutionStatusSchema;
export type WorkflowActionStatus = WorkflowExecutionStatus;

export const workflowConditionSchema = z
  .object({
    field: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-zA-Z0-9_]*$/),
    operator: z.enum(["EQ", "NE", "LT", "LTE", "GT", "GTE", "IN", "CONTAINS"]),
    value: z.json(),
  })
  .strict();
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

export const workflowNotificationActionSchema = z
  .object({
    recipient: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ACTOR") }).strict(),
      z
        .object({
          type: z.literal("PAYLOAD_USER_ID"),
          field: z.literal("userId"),
        })
        .strict(),
    ]),
    notificationType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type WorkflowNotificationAction = z.infer<
  typeof workflowNotificationActionSchema
>;

export const workflowTriggerConfigurationSchema = z.object({}).strict();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compare(left: unknown, right: unknown): number | undefined {
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return undefined;
}

export function evaluateWorkflowCondition(
  conditionInput: unknown,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const condition = workflowConditionSchema.parse(conditionInput);
  if (!Object.hasOwn(payload, condition.field)) {
    throw new TypeError("WORKFLOW_CONDITION_FIELD_UNAVAILABLE");
  }
  const actual = payload[condition.field];
  switch (condition.operator) {
    case "EQ":
      return canonicalJson(actual) === canonicalJson(condition.value);
    case "NE":
      return canonicalJson(actual) !== canonicalJson(condition.value);
    case "LT":
    case "LTE":
    case "GT":
    case "GTE": {
      const ordering = compare(actual, condition.value);
      if (ordering === undefined) {
        throw new TypeError("WORKFLOW_CONDITION_TYPES_UNSUPPORTED");
      }
      if (condition.operator === "LT") return ordering < 0;
      if (condition.operator === "LTE") return ordering <= 0;
      if (condition.operator === "GT") return ordering > 0;
      return ordering >= 0;
    }
    case "IN":
      if (!Array.isArray(condition.value)) {
        throw new TypeError("WORKFLOW_CONDITION_VALUE_INVALID");
      }
      return condition.value.some(
        (candidate) => canonicalJson(candidate) === canonicalJson(actual),
      );
    case "CONTAINS":
      if (typeof actual === "string" && typeof condition.value === "string") {
        return actual.includes(condition.value);
      }
      if (Array.isArray(actual)) {
        return actual.some(
          (candidate) =>
            canonicalJson(candidate) === canonicalJson(condition.value),
        );
      }
      throw new TypeError("WORKFLOW_CONDITION_TYPES_UNSUPPORTED");
  }
}

export function validateWorkflowTriggerPayload(
  eventType: WorkflowTriggerEventType,
  payload: unknown,
): Record<string, unknown> {
  const parsed = eventRegistry[eventType].payloadSchema.parse(payload);
  return Object.fromEntries(Object.entries(parsed));
}
