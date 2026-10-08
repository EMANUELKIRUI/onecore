import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowCondition,
  validateWorkflowTriggerPayload,
  workflowNotificationActionSchema,
  workflowTriggerConfigurationSchema,
  workflowTriggerEventTypes,
} from "../src/workflows.js";

describe("workflow contracts", () => {
  it("limits triggers to the registered platform event allowlist", () => {
    expect(workflowTriggerEventTypes).toContain("USER_CREATED");
    expect(workflowTriggerEventTypes).not.toContain(
      "NOTIFICATION_CREATED" as (typeof workflowTriggerEventTypes)[number],
    );
    expect(workflowTriggerConfigurationSchema.safeParse({}).success).toBe(true);
    expect(
      workflowTriggerConfigurationSchema.safeParse({
        eventType: "USER_CREATED",
      }).success,
    ).toBe(false);
  });

  it("validates event payloads against their registered contract", () => {
    expect(
      validateWorkflowTriggerPayload("USER_CREATED", {
        userId: crypto.randomUUID(),
        email: "user@example.test",
        displayName: "Test User",
      }),
    ).toHaveProperty("userId");
    expect(() =>
      validateWorkflowTriggerPayload("USER_CREATED", {
        userId: crypto.randomUUID(),
        email: "user@example.test",
        displayName: "Test User",
        password: "never allowed",
      }),
    ).toThrow();
  });

  it("evaluates only deterministic allow-listed operators on top-level event fields", () => {
    const payload = { status: "ACTIVE", count: 3, tags: ["a", "b"] };
    expect(
      evaluateWorkflowCondition(
        { field: "status", operator: "EQ", value: "ACTIVE" },
        payload,
      ),
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(
        { field: "count", operator: "GTE", value: 3 },
        payload,
      ),
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(
        { field: "tags", operator: "CONTAINS", value: "b" },
        payload,
      ),
    ).toBe(true);
    expect(() =>
      evaluateWorkflowCondition(
        { field: "constructor", operator: "EQ", value: {} },
        payload,
      ),
    ).toThrow("WORKFLOW_CONDITION_FIELD_UNAVAILABLE");
    expect(() =>
      evaluateWorkflowCondition(
        { field: "status.constructor", operator: "EQ", value: "ACTIVE" },
        payload,
      ),
    ).toThrow();
    expect(() =>
      evaluateWorkflowCondition(
        { field: "status", operator: "EXEC", value: "ACTIVE" },
        payload,
      ),
    ).toThrow();
  });

  it("rejects executable or unbounded notification action configuration", () => {
    expect(
      workflowNotificationActionSchema.safeParse({
        recipient: { type: "PAYLOAD_USER_ID", field: "userId" },
        notificationType: "workflow.update",
        title: "Update",
        body: "A safe notification",
      }).success,
    ).toBe(true);
    expect(
      workflowNotificationActionSchema.safeParse({
        recipient: { type: "PAYLOAD_USER_ID", field: "email" },
        notificationType: "workflow.update",
        title: "Update",
        body: "A safe notification",
      }).success,
    ).toBe(false);
    expect(
      workflowNotificationActionSchema.safeParse({
        recipient: { type: "ACTOR" },
        notificationType: "workflow.update",
        title: "Update",
        body: "A safe notification",
        execute: "ignored",
      }).success,
    ).toBe(false);
  });
});
