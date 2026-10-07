import { describe, expect, it } from "vitest";
import type { ResolvedAuthorizationContext } from "../src/authorization.js";
import { jobs } from "../schema/index.js";
import {
  resourceScopeAllowsCreate,
  resourceScopePredicate,
} from "../src/resource-authorization.js";

function context(
  scopeType: ResolvedAuthorizationContext["permissions"][number]["scopeType"],
  branchAccessMode: ResolvedAuthorizationContext["branchAccessMode"] = "ALL",
  branchId: string | null = null,
): ResolvedAuthorizationContext {
  return {
    userId: "8a542f6f-09c9-498f-b944-7ea4f1bf67e7",
    sessionId: "be9dc904-7d29-4b41-b2ac-93370e34a7e4",
    organizationId: "00331a99-5402-4738-9e62-89a511b19327",
    membershipId: "1fdbed5f-76fc-4119-8ad8-d417fc91eb8e",
    branchId,
    branch: null,
    branchAccessMode,
    roles: [],
    platformRoles: [],
    permissions: [
      {
        key: "core.organization.jobs.manage",
        moduleKey: "core.organization",
        scopeType,
        scope: {},
      },
    ],
  };
}

describe("business resource row authorization", () => {
  const columns = {
    organizationId: jobs.organizationId,
    branchId: jobs.branchId,
    ownerUserId: jobs.createdByUserId,
  };

  it("creates query predicates only for scopes supported by the resource", () => {
    expect(
      resourceScopePredicate(
        context("ORGANIZATION"),
        "core.organization.jobs.manage",
        columns,
      ),
    ).toBeDefined();
    expect(
      resourceScopePredicate(
        context("BRANCH", "ALL", "7a6fa4c7-f7a2-480d-9d5a-d15c56637439"),
        "core.organization.jobs.manage",
        columns,
      ),
    ).toBeDefined();
    expect(
      resourceScopePredicate(
        context("OWN"),
        "core.organization.jobs.manage",
        columns,
      ),
    ).toBeDefined();
    expect(
      resourceScopePredicate(
        context("ASSIGNED"),
        "core.organization.jobs.manage",
        { organizationId: columns.organizationId, branchId: columns.branchId },
      ),
    ).toBeUndefined();
    expect(
      resourceScopePredicate(
        context("CUSTOM"),
        "core.organization.jobs.manage",
        columns,
      ),
    ).toBeUndefined();
  });

  it("requires the current assigned branch regardless of the row scope", () => {
    const branchContext = context(
      "OWN",
      "ASSIGNED",
      "7a6fa4c7-f7a2-480d-9d5a-d15c56637439",
    );
    expect(
      resourceScopePredicate(
        branchContext,
        "core.organization.jobs.manage",
        columns,
      ),
    ).toBeDefined();
    expect(
      resourceScopePredicate(
        context("OWN", "ASSIGNED"),
        "core.organization.jobs.manage",
        columns,
      ),
    ).toBeUndefined();
  });

  it("validates organization, branch, and ownership for created rows", () => {
    const organizationId = "00331a99-5402-4738-9e62-89a511b19327";
    const branchId = "7a6fa4c7-f7a2-480d-9d5a-d15c56637439";
    const ownerUserId = "8a542f6f-09c9-498f-b944-7ea4f1bf67e7";

    expect(
      resourceScopeAllowsCreate(
        context("ORGANIZATION"),
        "core.organization.jobs.manage",
        {
          organizationId,
          branchId: null,
        },
      ),
    ).toBe(true);
    expect(
      resourceScopeAllowsCreate(
        context("BRANCH", "ALL", branchId),
        "core.organization.jobs.manage",
        {
          organizationId,
          branchId,
        },
      ),
    ).toBe(true);
    expect(
      resourceScopeAllowsCreate(
        context("BRANCH", "ALL", branchId),
        "core.organization.jobs.manage",
        {
          organizationId,
          branchId: null,
        },
      ),
    ).toBe(false);
    expect(
      resourceScopeAllowsCreate(
        context("OWN"),
        "core.organization.jobs.manage",
        {
          organizationId,
          branchId: null,
          ownerUserId,
        },
      ),
    ).toBe(true);
    expect(
      resourceScopeAllowsCreate(
        context("OWN"),
        "core.organization.jobs.manage",
        {
          organizationId: "90e5889d-07b0-4093-bd4d-2c6ea9058c56",
          branchId: null,
          ownerUserId,
        },
      ),
    ).toBe(false);
  });
});
