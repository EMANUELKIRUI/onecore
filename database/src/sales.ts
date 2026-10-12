import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  calculateSaleTotals,
  createDomainEvent,
  type SaleCreateRequest,
  type SaleListQuery,
} from "@onecore/core-domain";
import {
  writeAuthorizationMutationEvent,
  type ResolvedAuthorizationContext,
} from "./authorization.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import { recordOutboxEvent } from "./outbox.js";
import {
  createSaleReservations,
  releaseSaleReservations,
  type SaleStockLine,
} from "./inventory.js";
import { catalogItems, saleLines, sales } from "../schema/index.js";
import {
  resourceScopeAllowsCreate,
  resourceScopePredicate,
} from "./resource-authorization.js";

const createPermission = "core.sales.sale.create";
const readPermission = "core.sales.sale.read";

export interface SaleWithLines {
  id: string;
  organizationId: string;
  branchId: string;
  status: "OPEN" | "CANCELLED";
  currency: string;
  subtotal: string;
  total: string;
  createdByUserId: string;
  createdAt: Date;
  lines: {
    id: string;
    catalogItemId: string;
    lineNumber: number;
    itemName: string;
    description: string | null;
    reference: string | null;
    unit: string;
    unitPrice: string;
    quantity: number;
    lineTotal: string;
  }[];
}

export type CreateSaleOutcome =
  | { outcome: "CREATED" | "EXISTING"; sale: SaleWithLines }
  | {
      outcome:
        | "IDEMPOTENCY_CONFLICT"
        | "CATALOG_ITEM_UNAVAILABLE"
        | "CURRENCY_MISMATCH"
        | "FORBIDDEN";
    };

function requestHash(
  input: SaleCreateRequest,
  branchId: string,
  userId: string,
): string {
  const lines = [...input.lines].sort((left, right) =>
    left.catalogItemId.localeCompare(right.catalogItemId),
  );
  return createHash("sha256")
    .update(JSON.stringify({ branchId, userId, lines }))
    .digest("hex");
}

async function saleWithLines(
  transaction: OrganizationTransaction,
  saleId: string,
  organizationId: string,
): Promise<SaleWithLines | undefined> {
  const [sale] = await transaction
    .select()
    .from(sales)
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, saleId)))
    .limit(1);
  if (!sale) return undefined;
  const lines = await transaction
    .select({
      id: saleLines.id,
      catalogItemId: saleLines.catalogItemId,
      lineNumber: saleLines.lineNumber,
      itemName: saleLines.itemName,
      description: saleLines.description,
      reference: saleLines.reference,
      unit: saleLines.unit,
      unitPrice: saleLines.unitPrice,
      quantity: saleLines.quantity,
      lineTotal: saleLines.lineTotal,
    })
    .from(saleLines)
    .where(
      and(
        eq(saleLines.organizationId, organizationId),
        eq(saleLines.saleId, saleId),
      ),
    )
    .orderBy(asc(saleLines.lineNumber));
  return { ...sale, lines };
}

async function existingOutcome(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  idempotencyKey: string,
  hash: string,
): Promise<CreateSaleOutcome | undefined> {
  const [existing] = await transaction
    .select({ id: sales.id, requestHash: sales.requestHash })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, context.organizationId),
        eq(sales.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) return undefined;
  if (existing.requestHash !== hash) {
    return { outcome: "IDEMPOTENCY_CONFLICT" };
  }
  const sale = await saleWithLines(
    transaction,
    existing.id,
    context.organizationId,
  );
  return sale
    ? { outcome: "EXISTING", sale }
    : { outcome: "IDEMPOTENCY_CONFLICT" };
}

export async function createSale(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  input: SaleCreateRequest,
  idempotencyKey: string,
  requestId = idempotencyKey,
): Promise<CreateSaleOutcome> {
  const branchId = context.branchId;
  if (
    !branchId ||
    !resourceScopeAllowsCreate(context, createPermission, {
      organizationId: context.organizationId,
      branchId,
      ownerUserId: context.userId,
    }) ||
    !resourceScopeAllowsCreate(context, "core.inventory.stock.reserve", {
      organizationId: context.organizationId,
      branchId,
      ownerUserId: context.userId,
    })
  ) {
    return { outcome: "FORBIDDEN" };
  }

  const hash = requestHash(input, branchId, context.userId);
  const prior = await existingOutcome(
    transaction,
    context,
    idempotencyKey,
    hash,
  );
  if (prior) return prior;

  const itemIds = input.lines.map(({ catalogItemId }) => catalogItemId);
  const items = await transaction
    .select({
      id: catalogItems.id,
      branchId: catalogItems.branchId,
      reference: catalogItems.reference,
      name: catalogItems.name,
      type: catalogItems.type,
      description: catalogItems.description,
      unit: catalogItems.unit,
      price: catalogItems.price,
      currency: catalogItems.currency,
      status: catalogItems.status,
    })
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.organizationId, context.organizationId),
        inArray(catalogItems.id, itemIds),
        eq(catalogItems.status, "ACTIVE"),
        sql`(${catalogItems.branchId} IS NULL OR ${catalogItems.branchId} = ${branchId})`,
      ),
    )
    .orderBy(asc(catalogItems.id))
    .for("share");
  if (items.length !== input.lines.length) {
    return { outcome: "CATALOG_ITEM_UNAVAILABLE" };
  }
  const currency = items[0]?.currency;
  if (!currency || items.some((item) => item.currency !== currency)) {
    return { outcome: "CURRENCY_MISMATCH" };
  }

  const itemById = new Map(items.map((item) => [item.id, item]));
  const requestLines = input.lines.map((line) => {
    const item = itemById.get(line.catalogItemId);
    if (!item) throw new Error("Validated catalog item is missing");
    return { unitPrice: item.price, quantity: line.quantity };
  });
  const totals = calculateSaleTotals(requestLines);
  const [sale] = await transaction
    .insert(sales)
    .values({
      organizationId: context.organizationId,
      branchId,
      currency,
      subtotal: totals.subtotal,
      total: totals.total,
      idempotencyKey,
      requestHash: hash,
      createdByUserId: context.userId,
    })
    .onConflictDoNothing({
      target: [sales.organizationId, sales.idempotencyKey],
    })
    .returning({ id: sales.id });

  if (!sale) {
    return (
      (await existingOutcome(transaction, context, idempotencyKey, hash)) ?? {
        outcome: "IDEMPOTENCY_CONFLICT",
      }
    );
  }

  await transaction.insert(saleLines).values(
    input.lines.map((line, index) => {
      const item = itemById.get(line.catalogItemId);
      const total = totals.lines[index];
      if (!item || !total) throw new Error("Validated sale line is missing");
      return {
        organizationId: context.organizationId,
        saleId: sale.id,
        catalogItemId: item.id,
        lineNumber: index + 1,
        itemName: item.name,
        description: item.description,
        reference: item.reference,
        unit: item.unit,
        unitPrice: item.price,
        quantity: line.quantity,
        lineTotal: total.lineTotal,
      };
    }),
  );

  await createSaleReservations(
    transaction,
    context,
    sale.id,
    input.lines.map((line): SaleStockLine => ({
      catalogItemId: line.catalogItemId,
      itemType:
        itemById.get(line.catalogItemId)?.type === "SERVICE"
          ? "SERVICE"
          : "PRODUCT",
      quantity: line.quantity,
    })),
    requestId,
  );

  const created = await saleWithLines(
    transaction,
    sale.id,
    context.organizationId,
  );
  if (!created) throw new Error("Created sale could not be reloaded");
  return { outcome: "CREATED", sale: created };
}

export type CancelSaleOutcome =
  | { outcome: "CANCELLED" | "EXISTING"; sale: SaleWithLines }
  | { outcome: "NOT_FOUND" | "FORBIDDEN" };

export async function cancelSale(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  saleId: string,
  requestId: string,
): Promise<CancelSaleOutcome> {
  const branchId = context.branchId;
  const scope = branchId
    ? resourceScopePredicate(context, "core.sales.sale.cancel", {
        organizationId: sales.organizationId,
        branchId: sales.branchId,
        ownerUserId: sales.createdByUserId,
      })
    : undefined;
  if (!branchId || !scope) return { outcome: "FORBIDDEN" };
  const [sale] = await transaction
    .select({ id: sales.id, status: sales.status })
    .from(sales)
    .where(
      and(
        scope,
        eq(sales.organizationId, context.organizationId),
        eq(sales.branchId, branchId),
        eq(sales.id, saleId),
      ),
    )
    .for("update")
    .limit(1);
  if (!sale) return { outcome: "NOT_FOUND" };
  if (sale.status === "CANCELLED") {
    const existing = await saleWithLines(
      transaction,
      sale.id,
      context.organizationId,
    );
    return existing
      ? { outcome: "EXISTING", sale: existing }
      : { outcome: "NOT_FOUND" };
  }

  const releasedLineCount = await releaseSaleReservations(
    transaction,
    context,
    sale.id,
    requestId,
  );
  await transaction
    .update(sales)
    .set({
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: context.userId,
    })
    .where(
      and(
        eq(sales.organizationId, context.organizationId),
        eq(sales.branchId, branchId),
        eq(sales.id, sale.id),
        eq(sales.status, "OPEN"),
      ),
    );
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "SALE_CANCELLED",
      organizationId: context.organizationId,
      branchId,
      actorUserId: context.userId,
      aggregateType: "sale",
      aggregateId: sale.id,
      payload: { saleId: sale.id, releasedLineCount },
      metadata: { requestId },
    }),
  );
  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    "SALE_CANCELLED",
    "sale",
    sale.id,
    { releasedLineCount },
  );
  const cancelled = await saleWithLines(
    transaction,
    sale.id,
    context.organizationId,
  );
  if (!cancelled) return { outcome: "NOT_FOUND" };
  return { outcome: "CANCELLED", sale: cancelled };
}

function saleReadScope(context: ResolvedAuthorizationContext) {
  if (!context.branchId) return undefined;
  const permissionScope = resourceScopePredicate(context, readPermission, {
    organizationId: sales.organizationId,
    branchId: sales.branchId,
    ownerUserId: sales.createdByUserId,
  });
  if (!permissionScope) return undefined;
  return and(
    permissionScope,
    eq(sales.organizationId, context.organizationId),
    eq(sales.branchId, context.branchId),
  );
}

export async function getSale(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  saleId: string,
): Promise<SaleWithLines | undefined> {
  const scope = saleReadScope(context);
  if (!scope) return undefined;
  const [sale] = await transaction
    .select({ id: sales.id })
    .from(sales)
    .where(and(scope, eq(sales.id, saleId)))
    .limit(1);
  if (!sale) return undefined;
  return saleWithLines(transaction, sale.id, context.organizationId);
}

export async function listSales(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  query: SaleListQuery,
) {
  const scope = saleReadScope(context);
  if (!scope) return undefined;
  const [countRow] = await transaction
    .select({ total: sql<number>`count(*)::int` })
    .from(sales)
    .where(scope);
  const items = await transaction
    .select()
    .from(sales)
    .where(scope)
    .orderBy(desc(sales.createdAt), desc(sales.id))
    .limit(query.limit)
    .offset(query.offset);
  return { items, total: countRow?.total ?? 0 };
}
