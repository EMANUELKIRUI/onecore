import { describe, expect, it } from "vitest";
import {
  customFieldTypes,
  canTransitionOrganizationStatus,
  canTransitionUserAccountStatus,
  branchStatusSchema,
  membershipBranchAccessModeSchema,
  deploymentTypeSchema,
  createPermissionKey,
  permissionDefinitionSchema,
  organizationStatusSchema,
  parseCustomFieldValue,
} from "../src/index.js";

describe("platform domain values", () => {
  it("restricts deployment type and organization lifecycle to platform values", () => {
    expect(deploymentTypeSchema.parse("SAAS")).toBe("SAAS");
    expect(deploymentTypeSchema.parse("DEDICATED")).toBe("DEDICATED");
    expect(() => deploymentTypeSchema.parse("CUSTOMER_FORK")).toThrow();

    for (const status of [
      "PENDING",
      "UNDER_REVIEW",
      "APPROVED",
      "PAYMENT_PENDING",
      "ACTIVE",
      "SUSPENDED",
      "EXPIRED",
      "REJECTED",
      "CANCELLED",
    ]) {
      expect(organizationStatusSchema.parse(status)).toBe(status);
    }
  });

  it("parses all supported custom field value types", () => {
    const values: Record<(typeof customFieldTypes)[number], unknown> = {
      TEXT: "Room preference",
      NUMBER: 12.5,
      BOOLEAN: true,
      DATE: "2026-10-05",
      DATETIME: "2026-10-05T15:00:00Z",
      CURRENCY: { amount: "1250.50", currencyCode: "KES" },
      SELECT: "standard",
      MULTI_SELECT: ["small", "blue"],
      REFERENCE: {
        resource: "customer",
        id: "f279c1aa-53b3-45f1-8cc5-552d4102e7ce",
      },
    };

    for (const fieldType of customFieldTypes) {
      expect(parseCustomFieldValue(fieldType, values[fieldType])).toEqual(
        values[fieldType],
      );
    }
    expect(() => parseCustomFieldValue("NUMBER", Number.NaN)).toThrow();
    expect(() =>
      parseCustomFieldValue("CURRENCY", {
        amount: "12.1234567",
        currencyCode: "KES",
      }),
    ).toThrow();
  });

  it("allows only defined account lifecycle transitions", () => {
    expect(canTransitionUserAccountStatus("PENDING", "ACTIVE")).toBe(true);
    expect(canTransitionUserAccountStatus("ACTIVE", "LOCKED")).toBe(true);
    expect(canTransitionUserAccountStatus("LOCKED", "ACTIVE")).toBe(true);
    expect(canTransitionUserAccountStatus("DISABLED", "ACTIVE")).toBe(false);
    expect(canTransitionUserAccountStatus("PENDING", "SUSPENDED")).toBe(false);
  });

  it("enforces organization transitions and typed branch access values", () => {
    expect(canTransitionOrganizationStatus("PENDING", "UNDER_REVIEW")).toBe(
      true,
    );
    expect(canTransitionOrganizationStatus("ACTIVE", "SUSPENDED")).toBe(true);
    expect(canTransitionOrganizationStatus("SUSPENDED", "ACTIVE")).toBe(true);
    expect(canTransitionOrganizationStatus("REJECTED", "ACTIVE")).toBe(false);
    expect(canTransitionOrganizationStatus("CANCELLED", "ACTIVE")).toBe(false);
    expect(branchStatusSchema.parse("CLOSED")).toBe("CLOSED");
    expect(membershipBranchAccessModeSchema.parse("ASSIGNED")).toBe("ASSIGNED");
    expect(membershipBranchAccessModeSchema.parse("ALL")).toBe("ALL");
  });

  it("builds deterministic permission keys from validated module resources and actions", () => {
    expect(createPermissionKey("sales", "sale", "create")).toBe(
      "sales.sale.create",
    );
    expect(createPermissionKey("core.organization", "settings", "update")).toBe(
      "core.organization.settings.update",
    );
    expect(
      permissionDefinitionSchema.parse({
        module: "inventory",
        resource: "stock-item",
        action: "adjust",
      }).key,
    ).toBe("inventory.stock-item.adjust");
    expect(() => createPermissionKey("Sales", "sale", "create")).toThrow();
    expect(() => createPermissionKey("sales", "sale.create", "read")).toThrow();
    expect(() => createPermissionKey("sales", "sale", "read all")).toThrow();
  });
});
