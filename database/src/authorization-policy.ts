import type { DataScopeType } from "@onecore/core-domain";
import type { PermissionGrant } from "./authorization.js";

export interface PermissionGrantCandidate extends PermissionGrant {
  roleStatus: "ACTIVE" | "INACTIVE";
  permissionStatus: "ACTIVE" | "INACTIVE";
}

function narrowScope(
  granted: DataScopeType,
  membershipScopes: readonly DataScopeType[],
): DataScopeType[] {
  if (membershipScopes.length === 0) return [granted];
  const narrowed = new Set<DataScopeType>();
  for (const maximum of membershipScopes) {
    if (maximum === "ORGANIZATION" || maximum === granted) {
      narrowed.add(granted);
    } else if (
      maximum === "BRANCH" &&
      (granted === "ORGANIZATION" || granted === "BRANCH")
    ) {
      narrowed.add("BRANCH");
    } else if (
      maximum === "OWN" &&
      ["ORGANIZATION", "BRANCH", "SELF", "OWN"].includes(granted)
    ) {
      narrowed.add("OWN");
    } else if (
      maximum === "ASSIGNED" &&
      ["ORGANIZATION", "BRANCH", "ASSIGNED"].includes(granted)
    ) {
      narrowed.add("ASSIGNED");
    } else if (
      maximum === "CUSTOM" &&
      ["ORGANIZATION", "BRANCH", "CUSTOM", "DEPARTMENT"].includes(granted)
    ) {
      narrowed.add("CUSTOM");
    } else if (maximum === "DEPARTMENT" && granted === "ORGANIZATION") {
      narrowed.add("DEPARTMENT");
    } else if (maximum === "SELF" && granted === "ORGANIZATION") {
      narrowed.add("OWN");
    }
  }
  return [...narrowed];
}

export function resolveEffectivePermissionGrants(
  grants: readonly PermissionGrantCandidate[],
  membershipScopes: readonly DataScopeType[],
  branchAccessMode: "ALL" | "ASSIGNED",
  entitledModules: ReadonlySet<string>,
): PermissionGrant[] {
  const effective: PermissionGrant[] = [];
  for (const grant of grants) {
    if (
      grant.roleStatus !== "ACTIVE" ||
      grant.permissionStatus !== "ACTIVE" ||
      !entitledModules.has(grant.moduleKey)
    ) {
      continue;
    }
    const scopes = narrowScope(grant.scopeType, membershipScopes);
    for (const scopeType of scopes) {
      effective.push({
        key: grant.key,
        moduleKey: grant.moduleKey,
        scopeType:
          branchAccessMode === "ASSIGNED" && scopeType === "ORGANIZATION"
            ? "BRANCH"
            : scopeType,
        scope: grant.scope,
      });
    }
  }
  return effective;
}

export function permissionRequiresBranch(
  scopes: readonly DataScopeType[],
): boolean {
  return scopes.includes("BRANCH");
}
