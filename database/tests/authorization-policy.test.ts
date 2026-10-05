import { describe, expect, it } from "vitest";
import {
  permissionRequiresBranch,
  resolveEffectivePermissionGrants,
  type PermissionGrantCandidate,
} from "../src/authorization-policy.js";

const grant = (
  overrides: Partial<PermissionGrantCandidate> = {},
): PermissionGrantCandidate => ({
  key: "inventory.product.create",
  moduleKey: "inventory",
  roleStatus: "ACTIVE",
  permissionStatus: "ACTIVE",
  scopeType: "ORGANIZATION",
  scope: {},
  ...overrides,
});

describe("authorization policy resolution", () => {
  it("unions permissions from multiple active roles", () => {
    const resolved = resolveEffectivePermissionGrants(
      [
        grant({ key: "inventory.product.create" }),
        grant({ key: "inventory.product.read", scopeType: "OWN" }),
      ],
      [],
      "ALL",
      new Set(["inventory"]),
    );

    expect(resolved.map(({ key }) => key)).toEqual([
      "inventory.product.create",
      "inventory.product.read",
    ]);
  });

  it("excludes inactive roles, inactive permissions, and unentitled modules", () => {
    const resolved = resolveEffectivePermissionGrants(
      [
        grant({ key: "inventory.product.create" }),
        grant({
          key: "inventory.product.update",
          roleStatus: "INACTIVE",
        }),
        grant({
          key: "inventory.product.delete",
          permissionStatus: "INACTIVE",
        }),
        grant({
          key: "sales.sale.read",
          moduleKey: "sales",
        }),
      ],
      [],
      "ALL",
      new Set(["inventory"]),
    );

    expect(resolved.map(({ key }) => key)).toEqual([
      "inventory.product.create",
    ]);
  });

  it("narrows organization grants to branch access and honors member scope ceilings", () => {
    const assignedBranch = resolveEffectivePermissionGrants(
      [grant()],
      [],
      "ASSIGNED",
      new Set(["inventory"]),
    );
    expect(assignedBranch[0]?.scopeType).toBe("BRANCH");

    const explicitBranchCeiling = resolveEffectivePermissionGrants(
      [grant()],
      ["BRANCH"],
      "ALL",
      new Set(["inventory"]),
    );
    expect(explicitBranchCeiling[0]?.scopeType).toBe("BRANCH");

    expect(
      resolveEffectivePermissionGrants(
        [grant({ scopeType: "OWN" })],
        ["BRANCH"],
        "ALL",
        new Set(["inventory"]),
      ),
    ).toEqual([]);
  });

  it("requires a verified branch only for branch-scoped permissions", () => {
    expect(permissionRequiresBranch(["ORGANIZATION"])).toBe(false);
    expect(permissionRequiresBranch(["BRANCH"])).toBe(true);
    expect(permissionRequiresBranch(["OWN", "ASSIGNED"])).toBe(false);
    expect(permissionRequiresBranch([])).toBe(false);
  });
});
