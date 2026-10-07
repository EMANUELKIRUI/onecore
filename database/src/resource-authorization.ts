import { and, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ResolvedAuthorizationContext } from "./authorization.js";

export interface ResourceScopeColumns {
  organizationId: AnyPgColumn;
  branchId?: AnyPgColumn;
  ownerUserId?: AnyPgColumn;
  assignedUserId?: AnyPgColumn;
}

export interface ResourceScopeValues {
  organizationId: string;
  branchId: string | null;
  ownerUserId?: string | null;
  assignedUserId?: string | null;
}

function permissionScopes(
  context: ResolvedAuthorizationContext,
  permissionKey: string,
) {
  return context.permissions
    .filter((permission) => permission.key === permissionKey)
    .map(({ scopeType }) => scopeType);
}

export function resourceScopePredicate(
  context: ResolvedAuthorizationContext,
  permissionKey: string,
  columns: ResourceScopeColumns,
): SQL | undefined {
  const assignedBranch =
    context.branchAccessMode === "ASSIGNED" ? context.branchId : null;
  if (context.branchAccessMode === "ASSIGNED" && !assignedBranch) {
    return undefined;
  }
  if (assignedBranch && !columns.branchId) return undefined;

  const rowScopes: SQL[] = [];
  for (const scope of permissionScopes(context, permissionKey)) {
    if (scope === "ORGANIZATION") {
      rowScopes.push(sql`true`);
    } else if (scope === "BRANCH" && context.branchId && columns.branchId) {
      rowScopes.push(eq(columns.branchId, context.branchId));
    } else if ((scope === "OWN" || scope === "SELF") && columns.ownerUserId) {
      rowScopes.push(eq(columns.ownerUserId, context.userId));
    } else if (scope === "ASSIGNED" && columns.assignedUserId) {
      rowScopes.push(eq(columns.assignedUserId, context.userId));
    }
  }

  if (rowScopes.length === 0) return undefined;
  const predicates = [
    eq(columns.organizationId, context.organizationId),
    or(...rowScopes),
  ];
  if (assignedBranch && columns.branchId) {
    predicates.push(eq(columns.branchId, assignedBranch));
  }
  return and(...predicates);
}

export function resourceScopeAllowsCreate(
  context: ResolvedAuthorizationContext,
  permissionKey: string,
  values: ResourceScopeValues,
): boolean {
  if (values.organizationId !== context.organizationId) return false;
  if (
    context.branchAccessMode === "ASSIGNED" &&
    (context.branchId === null || values.branchId !== context.branchId)
  ) {
    return false;
  }

  return permissionScopes(context, permissionKey).some((scope) => {
    if (scope === "ORGANIZATION") return true;
    if (scope === "BRANCH") {
      return context.branchId !== null && values.branchId === context.branchId;
    }
    if (scope === "OWN" || scope === "SELF") {
      return values.ownerUserId === context.userId;
    }
    if (scope === "ASSIGNED") {
      return values.assignedUserId === context.userId;
    }
    return false;
  });
}
