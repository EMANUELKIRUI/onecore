import { describe, expect, it } from "vitest";
import {
  calculateEventRetryDelay,
  createEventHandlerRegistry,
  isRetryableFailure,
  type EventHandler,
} from "../src/index.js";

const moduleHandler: EventHandler = {
  handlerName: "reporting.module-enabled",
  eventType: "MODULE_ENABLED",
  eventVersion: 1,
  owningModule: "core.reporting",
  requiredModuleEntitlement: "core.reporting",
  requiredPermissionKey: "core.reporting.events.consume",
  handle: async () => undefined,
};

describe("event handler registry and delivery policy", () => {
  it("resolves handlers by event type and version with declared requirements", () => {
    const registry = createEventHandlerRegistry([moduleHandler]);
    const matching = registry.resolve("MODULE_ENABLED", 1);

    expect(matching).toContain(moduleHandler);
    expect(matching[0]).toMatchObject({
      owningModule: "core.audit",
      requiredModuleEntitlement: null,
      requiredPermissionKey: null,
    });
    expect(registry.resolve("MODULE_ENABLED", 2)).toEqual([]);
    expect(registry.resolve("MODULE_DISABLED", 1)).toHaveLength(1);
  });

  it("rejects duplicate names and unsupported handler contracts", () => {
    expect(() =>
      createEventHandlerRegistry([moduleHandler, { ...moduleHandler }]),
    ).toThrow(/Duplicate event handler/);
    expect(() =>
      createEventHandlerRegistry([{ ...moduleHandler, eventVersion: 2 }]),
    ).toThrow(/unsupported event type\/version/);
  });

  it("uses bounded exponential retry delays and retries only transient classes", () => {
    expect(calculateEventRetryDelay(1)).toBe(1_000);
    expect(calculateEventRetryDelay(3)).toBe(4_000);
    expect(calculateEventRetryDelay(30)).toBe(3_600_000);
    expect(isRetryableFailure("TEMPORARY_DATABASE")).toBe(true);
    expect(isRetryableFailure("HANDLER_FAILURE")).toBe(true);
    expect(isRetryableFailure("AUTHORIZATION_FAILURE")).toBe(false);
    expect(isRetryableFailure("INVALID_EVENT")).toBe(false);
  });
});
