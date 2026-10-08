import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  CatalogItemCreateInput,
  CatalogListQuery,
  CatalogItemUpdateInput,
  CustomerCreateInput,
  CustomerListQuery,
  CustomerUpdateInput,
} from "@onecore/core-domain";
import type { ResolvedAuthorizationContext } from "./authorization.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import { catalogItems, customers } from "../schema/index.js";
import {
  resourceScopeAllowsCreate,
  resourceScopePredicate,
} from "./resource-authorization.js";

const customerPermissions = {
  create: "core.business_manager.customer.create",
  read: "core.business_manager.customer.read",
  update: "core.business_manager.customer.update",
  delete: "core.business_manager.customer.delete",
} as const;

const catalogPermissions = {
  create: "core.business_manager.catalog.create",
  read: "core.business_manager.catalog.read",
  update: "core.business_manager.catalog.update",
  delete: "core.business_manager.catalog.delete",
} as const;

function scopePredicate(
  context: ResolvedAuthorizationContext,
  permissionKey: string,
  resource: typeof customers | typeof catalogItems,
  includeOrganizationWideRowsInBranchScope = false,
): SQL | undefined {
  return resourceScopePredicate(context, permissionKey, {
    organizationId: resource.organizationId,
    branchId: resource.branchId,
    includeOrganizationWideRowsInBranchScope,
    ownerUserId: resource.createdByUserId,
  });
}

function searchPattern(search: string | undefined): string | undefined {
  const trimmed = search?.trim();
  if (!trimmed) return undefined;
  return `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function createCustomer(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  input: CustomerCreateInput,
): Promise<typeof customers.$inferSelect | undefined> {
  const branchId =
    input.branchId === undefined ? context.branchId : input.branchId;
  if (
    !resourceScopeAllowsCreate(context, customerPermissions.create, {
      organizationId: context.organizationId,
      branchId,
      ownerUserId: context.userId,
    })
  ) {
    return undefined;
  }
  const [customer] = await transaction
    .insert(customers)
    .values({
      ...input,
      branchId,
      organizationId: context.organizationId,
      createdByUserId: context.userId,
    })
    .returning();
  return customer;
}

export async function getCustomer(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  id: string,
) {
  const scope = scopePredicate(
    context,
    customerPermissions.read,
    customers,
    true,
  );
  if (!scope) return undefined;
  const [customer] = await transaction
    .select()
    .from(customers)
    .where(
      and(
        scope,
        eq(customers.organizationId, context.organizationId),
        eq(customers.id, id),
      ),
    )
    .limit(1);
  return customer;
}

export async function listCustomers(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  query: CustomerListQuery,
) {
  const scope = scopePredicate(
    context,
    customerPermissions.read,
    customers,
    true,
  );
  if (!scope) return undefined;
  const clauses: SQL[] = [
    scope,
    eq(customers.organizationId, context.organizationId),
  ];
  if (query.status) clauses.push(eq(customers.status, query.status));
  if (query.branchId) {
    clauses.push(
      or(eq(customers.branchId, query.branchId), isNull(customers.branchId))!,
    );
  }
  const pattern = searchPattern(query.search);
  if (pattern) {
    clauses.push(
      or(
        ilike(customers.name, pattern),
        ilike(customers.reference, pattern),
        ilike(customers.email, pattern),
        ilike(customers.phone, pattern),
      )!,
    );
  }
  const where = and(...clauses);
  const items = await transaction
    .select()
    .from(customers)
    .where(where)
    .orderBy(desc(customers.updatedAt), desc(customers.id))
    .limit(query.limit)
    .offset(query.offset);
  const [count] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(customers)
    .where(where);
  return { items, total: count?.count ?? 0 };
}

export async function updateCustomer(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  id: string,
  input: CustomerUpdateInput,
) {
  const scope = scopePredicate(context, customerPermissions.update, customers);
  if (!scope) return undefined;
  const [customer] = await transaction
    .update(customers)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(
        scope,
        eq(customers.organizationId, context.organizationId),
        eq(customers.id, id),
      ),
    )
    .returning();
  return customer;
}

export async function deleteCustomer(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  id: string,
) {
  const scope = scopePredicate(context, customerPermissions.delete, customers);
  if (!scope) return undefined;
  const [customer] = await transaction
    .update(customers)
    .set({ status: "INACTIVE", updatedAt: new Date() })
    .where(
      and(
        scope,
        eq(customers.organizationId, context.organizationId),
        eq(customers.id, id),
        eq(customers.status, "ACTIVE"),
      ),
    )
    .returning();
  return customer;
}

export async function createCatalogItem(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  input: CatalogItemCreateInput,
): Promise<typeof catalogItems.$inferSelect | undefined> {
  const branchId =
    input.branchId === undefined ? context.branchId : input.branchId;
  if (
    !resourceScopeAllowsCreate(context, catalogPermissions.create, {
      organizationId: context.organizationId,
      branchId,
      ownerUserId: context.userId,
    })
  ) {
    return undefined;
  }
  const [item] = await transaction
    .insert(catalogItems)
    .values({
      ...input,
      branchId,
      organizationId: context.organizationId,
      createdByUserId: context.userId,
    })
    .returning();
  return item;
}

export async function getCatalogItem(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  id: string,
) {
  const scope = scopePredicate(
    context,
    catalogPermissions.read,
    catalogItems,
    true,
  );
  if (!scope) return undefined;
  const [item] = await transaction
    .select()
    .from(catalogItems)
    .where(
      and(
        scope,
        eq(catalogItems.organizationId, context.organizationId),
        eq(catalogItems.id, id),
      ),
    )
    .limit(1);
  return item;
}

export async function listCatalogItems(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  query: CatalogListQuery,
) {
  const scope = scopePredicate(
    context,
    catalogPermissions.read,
    catalogItems,
    true,
  );
  if (!scope) return undefined;
  const clauses: SQL[] = [
    scope,
    eq(catalogItems.organizationId, context.organizationId),
  ];
  if (query.type) clauses.push(eq(catalogItems.type, query.type));
  if (query.status) clauses.push(eq(catalogItems.status, query.status));
  if (query.branchId) {
    clauses.push(
      or(
        eq(catalogItems.branchId, query.branchId),
        isNull(catalogItems.branchId),
      )!,
    );
  }
  const pattern = searchPattern(query.search);
  if (pattern) {
    clauses.push(
      or(
        ilike(catalogItems.name, pattern),
        ilike(catalogItems.reference, pattern),
      )!,
    );
  }
  const where = and(...clauses);
  const items = await transaction
    .select()
    .from(catalogItems)
    .where(where)
    .orderBy(desc(catalogItems.updatedAt), desc(catalogItems.id))
    .limit(query.limit)
    .offset(query.offset);
  const [count] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(catalogItems)
    .where(where);
  return { items, total: count?.count ?? 0 };
}

export async function updateCatalogItem(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  id: string,
  input: CatalogItemUpdateInput,
) {
  const scope = scopePredicate(
    context,
    catalogPermissions.update,
    catalogItems,
  );
  if (!scope) return undefined;
  const [item] = await transaction
    .update(catalogItems)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(
        scope,
        eq(catalogItems.organizationId, context.organizationId),
        eq(catalogItems.id, id),
      ),
    )
    .returning();
  return item;
}

export async function deleteCatalogItem(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  id: string,
) {
  const scope = scopePredicate(
    context,
    catalogPermissions.delete,
    catalogItems,
  );
  if (!scope) return undefined;
  const [item] = await transaction
    .update(catalogItems)
    .set({ status: "INACTIVE", updatedAt: new Date() })
    .where(
      and(
        scope,
        eq(catalogItems.organizationId, context.organizationId),
        eq(catalogItems.id, id),
        eq(catalogItems.status, "ACTIVE"),
      ),
    )
    .returning();
  return item;
}
