import { describe, expect, it } from "vitest";
import {
  resolveOrganizationModuleActivationAccess,
  resolveOrganizationModuleAccess,
  type OrganizationModuleCandidate,
} from "../src/module-entitlements.js";

const foundation: OrganizationModuleCandidate = {
  name: "core.foundation",
  lifecycle: "AVAILABLE",
  isAvailable: true,
  version: "1.2.0",
  entitlementStatus: "ENABLED",
  planAllowsModule: true,
  dependencies: [],
};

describe("organization module entitlement resolution", () => {
  it("requires registration, availability, entitlement, plan, and enabled dependencies", () => {
    const reporting: OrganizationModuleCandidate = {
      name: "core.reporting",
      lifecycle: "AVAILABLE",
      isAvailable: true,
      version: "1.0.0",
      entitlementStatus: "ENABLED",
      planAllowsModule: true,
      dependencies: [{ moduleName: foundation.name, minimumVersion: "1.0.0" }],
    };
    const allowed = resolveOrganizationModuleAccess([foundation, reporting]);
    expect(allowed.get(reporting.name)).toEqual({ allowed: true });

    const disabledDependency = resolveOrganizationModuleAccess([
      foundation,
      {
        ...reporting,
        dependencies: [{ moduleName: foundation.name, minimumVersion: null }],
      },
      { ...foundation, entitlementStatus: "DISABLED" },
    ]);
    expect(disabledDependency.get(reporting.name)).toEqual({
      allowed: false,
      reason: "DEPENDENCY_NOT_SATISFIED",
    });
  });

  it("fails closed for unavailable modules, absent entitlement, disallowed plans, and old dependencies", () => {
    const candidate = (overrides: Partial<OrganizationModuleCandidate>) => ({
      ...foundation,
      ...overrides,
    });
    expect(
      resolveOrganizationModuleAccess([
        candidate({ lifecycle: "QA", name: "core.qa" }),
      ]).get("core.qa"),
    ).toEqual({ allowed: false, reason: "MODULE_UNAVAILABLE" });
    expect(
      resolveOrganizationModuleAccess([
        candidate({ entitlementStatus: null }),
      ]).get(foundation.name),
    ).toEqual({ allowed: false, reason: "NOT_ENTITLED" });
    expect(
      resolveOrganizationModuleAccess([
        candidate({ planAllowsModule: false }),
      ]).get(foundation.name),
    ).toEqual({ allowed: false, reason: "SUBSCRIPTION_NOT_ALLOWED" });
    expect(
      resolveOrganizationModuleAccess([
        foundation,
        {
          ...foundation,
          name: "core.reporting",
          dependencies: [
            { moduleName: foundation.name, minimumVersion: "2.0.0" },
          ],
        },
      ]).get("core.reporting"),
    ).toEqual({ allowed: false, reason: "DEPENDENCY_NOT_SATISFIED" });
  });

  it("denies unknown dependency names and dependency cycles", () => {
    const unknown = {
      ...foundation,
      name: "core.unknown-dependent",
      dependencies: [{ moduleName: "missing.module", minimumVersion: null }],
    };
    expect(
      resolveOrganizationModuleAccess([unknown]).get(unknown.name),
    ).toEqual({ allowed: false, reason: "DEPENDENCY_NOT_SATISFIED" });

    const cycle = resolveOrganizationModuleAccess([
      {
        ...foundation,
        name: "core.a",
        dependencies: [{ moduleName: "core.b", minimumVersion: null }],
      },
      {
        ...foundation,
        name: "core.b",
        dependencies: [{ moduleName: "core.a", minimumVersion: null }],
      },
    ]);
    expect(cycle.get("core.a")).toEqual({
      allowed: false,
      reason: "DEPENDENCY_NOT_SATISFIED",
    });
  });

  it("checks activation dependencies independently of the target entitlement", () => {
    const qaDependency: OrganizationModuleCandidate = {
      ...foundation,
      name: "core.qa",
      lifecycle: "QA",
      entitlementStatus: null,
    };
    const dependent: OrganizationModuleCandidate = {
      ...foundation,
      name: "core.dependent",
      entitlementStatus: null,
      dependencies: [{ moduleName: qaDependency.name, minimumVersion: null }],
    };
    expect(
      resolveOrganizationModuleActivationAccess(
        [qaDependency, dependent],
        dependent.name,
      ),
    ).toEqual({
      allowed: false,
      reason: "DEPENDENCY_NOT_SATISFIED",
    });
    expect(
      resolveOrganizationModuleActivationAccess(
        [{ ...foundation, entitlementStatus: null }],
        foundation.name,
      ),
    ).toEqual({ allowed: true });
    expect(
      resolveOrganizationModuleActivationAccess(
        [{ ...foundation, planAllowsModule: false }],
        foundation.name,
      ),
    ).toEqual({
      allowed: false,
      reason: "SUBSCRIPTION_NOT_ALLOWED",
    });
  });
});
