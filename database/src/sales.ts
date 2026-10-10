import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  calculateSaleAmounts,
  createDomainEvent,
  type SaleCheckoutInput,
  type SaleListQuery,
} from "@onecore/core-domain";
import type { ResolvedAuthorizationContext } from "./authorization.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import {
  businessSettings,
  catalogItems,
  customers,
  organizationSettings,
  saleItems,
  salePayments,
  saleRefunds,
  sales,
} from "../schema/index.js";
import { recordOutboxEvent } from "./outbox.js";
import { writeAuthorizationMutationEvent } from "./authorization.js";
import { resourceScopePredicate } from "./resource-authorization.js";

const salesPermissions = {
  create: "sales.sale.create",
  read: "sales.sale.read",
  cancel: "sales.sale.cancel",
  refund: "sales.sale.refund",
} as const;

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function amountToMicros(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export class SalesOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesOperationError";
  }
}

async function saleContents(
  transaction: OrganizationTransaction,
  organizationId: string,
  branchId: string,
  saleId: string,
) {
  const [sale] = await transaction
    .select()
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, organizationId),
        eq(sales.branchId, branchId),
        eq(sales.id, saleId),
      ),
    )
    .limit(1);
  if (!sale) return undefined;
  const items = await transaction
    .select()
    .from(saleItems)
    .where(
      and(
        eq(saleItems.organizationId, organizationId),
        eq(saleItems.saleId, saleId),
      ),
    )
    .orderBy(asc(saleItems.createdAt), asc(saleItems.id));
  const [payment] = await transaction
    .select()
    .from(salePayments)
    .where(
      and(
        eq(salePayments.organizationId, organizationId),
        eq(salePayments.saleId, saleId),
      ),
    )
    .limit(1);
  return { sale, items, payment: payment ?? null };
}

export async function checkoutSale(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  input: SaleCheckoutInput,
  requestId: string,
) {
  const branchId = context.branch?.branchId;
  if (!branchId) throw new SalesOperationError("BRANCH_REQUIRED");
  if (
    !context.permissions.some(
      ({ key }) => key === "sales.sale.payment_record",
    )
  ) {
    throw new SalesOperationError("PAYMENT_NOT_AUTHORIZED");
  }
  const requestHash = hashRequest({
    ...input,
    discountAmount: input.discountAmount ?? "0",
    customerId: input.customerId ?? null,
  });
  const [existing] = await transaction
    .select()
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, context.organizationId),
        eq(sales.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.requestHash !== requestHash)
      throw new SalesOperationError("IDEMPOTENCY_KEY_REUSED");
    return {
      ...(await saleContents(
        transaction,
        context.organizationId,
        existing.branchId,
        existing.id,
      ))!,
      replayed: true,
    };
  }

  const ids = [
    ...new Set(input.items.map(({ catalogItemId }) => catalogItemId)),
  ];
  const foundItems = await transaction
    .select()
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.organizationId, context.organizationId),
        eq(catalogItems.status, "ACTIVE"),
        inArray(catalogItems.id, ids),
        or(
          eq(catalogItems.branchId, branchId),
          sql`${catalogItems.branchId} IS NULL`,
        ),
      ),
    );
  if (foundItems.length !== ids.length)
    throw new SalesOperationError("CATALOG_ITEM_UNAVAILABLE");
  const items = input.items.map((requested) => {
    const item = foundItems.find(({ id }) => id === requested.catalogItemId);
    if (!item) throw new SalesOperationError("CATALOG_ITEM_UNAVAILABLE");
    return { item, quantity: requested.quantity };
  });

  if (input.customerId) {
    const [customer] = await transaction
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, context.organizationId),
          eq(customers.id, input.customerId),
          eq(customers.status, "ACTIVE"),
          or(
            eq(customers.branchId, branchId),
            sql`${customers.branchId} IS NULL`,
          ),
        ),
      )
      .limit(1);
    if (!customer) throw new SalesOperationError("CUSTOMER_UNAVAILABLE");
  }

  const [settings] = await transaction
    .select({ paymentMethods: businessSettings.paymentMethods })
    .from(businessSettings)
    .where(eq(businessSettings.organizationId, context.organizationId))
    .limit(1);
  const configuredMethods = settings?.paymentMethods ?? [];
  if (!configuredMethods.includes(input.paymentMethod))
    throw new SalesOperationError("PAYMENT_METHOD_NOT_CONFIGURED");

  const [configuredOrganizationSettings] = await transaction
    .select({ taxInformation: organizationSettings.taxInformation })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, context.organizationId))
    .limit(1);
  let taxRateBasisPoints = 0;
  if (
    configuredOrganizationSettings?.taxInformation &&
    typeof configuredOrganizationSettings.taxInformation === "object"
  ) {
    const configuredTax = (
      configuredOrganizationSettings.taxInformation as Record<string, unknown>
    ).salesTaxRateBasisPoints;
    if (configuredTax !== undefined) {
      if (
        typeof configuredTax !== "number" ||
        !Number.isInteger(configuredTax) ||
        configuredTax < 0 ||
        configuredTax > 10_000
      )
        throw new SalesOperationError("TAX_CONFIGURATION_INVALID");
      taxRateBasisPoints = configuredTax;
    }
  }

  const discountAmount = input.discountAmount ?? "0";
  const discountPermission = context.permissions.some(
    (grant) => grant.key === "sales.sale.discount",
  );
  if (
    BigInt(discountAmount.split(".")[0] ?? "0") > 0n ||
    (discountAmount.split(".")[1] ?? "").replace(/0/g, "").length > 0
  ) {
    if (!discountPermission)
      throw new SalesOperationError("DISCOUNT_NOT_AUTHORIZED");
  }
  const amounts = calculateSaleAmounts(
    items.map(({ item, quantity }) => ({ price: item.price, quantity })),
    discountAmount,
    taxRateBasisPoints,
  );
  const currencies = new Set(items.map(({ item }) => item.currency));
  if (currencies.size !== 1) throw new SalesOperationError("MIXED_CURRENCY");
  const [sale] = await transaction
    .insert(sales)
    .values({
      organizationId: context.organizationId,
      branchId,
      saleNumber: `POS-${randomUUID()}`,
      customerId: input.customerId ?? null,
      cashierUserId: context.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      currency: items[0]!.item.currency,
      ...amounts,
    })
    .onConflictDoNothing({
      target: [sales.organizationId, sales.idempotencyKey],
    })
    .returning();
  if (!sale) {
    const [conflict] = await transaction
      .select()
      .from(sales)
      .where(
        and(
          eq(sales.organizationId, context.organizationId),
          eq(sales.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!conflict || conflict.requestHash !== requestHash)
      throw new SalesOperationError("IDEMPOTENCY_KEY_REUSED");
    return {
      ...(await saleContents(
        transaction,
        context.organizationId,
        conflict.branchId,
        conflict.id,
      ))!,
      replayed: true,
    };
  }

  await transaction.insert(saleItems).values(
    items.map(({ item, quantity }) => ({
      organizationId: context.organizationId,
      branchId,
      saleId: sale.id,
      catalogItemId: item.id,
      itemReference: item.reference,
      itemName: item.name,
      itemType: item.type,
      unit: item.unit,
      quantity,
      unitPrice: item.price,
      lineSubtotal: calculateSaleAmounts(
        [{ price: item.price, quantity }],
        "0",
        0,
      ).subtotal,
    })),
  );
  const [payment] = await transaction
    .insert(salePayments)
    .values({
      organizationId: context.organizationId,
      branchId,
      saleId: sale.id,
      paymentMethod: input.paymentMethod,
      amount: sale.total,
      paymentReference: input.paymentReference ?? null,
      recordedByUserId: context.userId,
    })
    .returning();
  if (!payment) throw new SalesOperationError("PAYMENT_RECORD_FAILED");

  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    "sales.sale.completed",
    "sale",
    sale.id,
    { saleNumber: sale.saleNumber, paymentMethod: input.paymentMethod },
  );
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "SALE_COMPLETED",
      organizationId: context.organizationId,
      branchId,
      actorUserId: context.userId,
      aggregateType: "sale",
      aggregateId: sale.id,
      payload: { saleId: sale.id, saleNumber: sale.saleNumber },
      metadata: { requestId },
    }),
  );
  return {
    sale,
    items: await transaction
      .select()
      .from(saleItems)
      .where(eq(saleItems.saleId, sale.id)),
    payment,
    replayed: false,
  };
}

export async function listSaleCatalogItems(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  search = "",
) {
  const branchId = context.branch?.branchId;
  if (!branchId) return undefined;
  const clauses = [
    eq(catalogItems.organizationId, context.organizationId),
    eq(catalogItems.status, "ACTIVE"),
    or(
      eq(catalogItems.branchId, branchId),
      sql`${catalogItems.branchId} IS NULL`,
    ),
  ];
  if (search.trim()) {
    const pattern = `%${search.trim().replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(
      or(
        sql`${catalogItems.name} ILIKE ${pattern}`,
        sql`${catalogItems.reference} ILIKE ${pattern}`,
      )!,
    );
  }
  return transaction
    .select({
      id: catalogItems.id,
      reference: catalogItems.reference,
      name: catalogItems.name,
      type: catalogItems.type,
      unit: catalogItems.unit,
      price: catalogItems.price,
      currency: catalogItems.currency,
    })
    .from(catalogItems)
    .where(and(...clauses))
    .orderBy(asc(catalogItems.name), asc(catalogItems.id))
    .limit(100);
}

export async function listSales(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  query: SaleListQuery,
) {
  const scope = resourceScopePredicate(context, salesPermissions.read, {
    organizationId: sales.organizationId,
    branchId: sales.branchId,
    ownerUserId: sales.cashierUserId,
  });
  if (!scope) return undefined;
  const clauses = [scope, eq(sales.organizationId, context.organizationId)];
  if (query.branchId) clauses.push(eq(sales.branchId, query.branchId));
  if (query.status) clauses.push(eq(sales.status, query.status));
  const where = and(...clauses);
  const items = await transaction
    .select()
    .from(sales)
    .where(where)
    .orderBy(desc(sales.createdAt), desc(sales.id))
    .limit(query.limit)
    .offset(query.offset);
  const [count] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(sales)
    .where(where);
  return { items, total: count?.count ?? 0 };
}

export async function getSale(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  saleId: string,
) {
  const scope = resourceScopePredicate(context, salesPermissions.read, {
    organizationId: sales.organizationId,
    branchId: sales.branchId,
    ownerUserId: sales.cashierUserId,
  });
  if (!scope) return undefined;
  const [sale] = await transaction
    .select()
    .from(sales)
    .where(
      and(
        scope,
        eq(sales.organizationId, context.organizationId),
        eq(sales.id, saleId),
      ),
    )
    .limit(1);
  if (!sale) return undefined;
  return saleContents(
    transaction,
    context.organizationId,
    sale.branchId,
    sale.id,
  );
}

export async function cancelSale(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  saleId: string,
  reason: string,
  requestId: string,
) {
  const scope = resourceScopePredicate(context, salesPermissions.cancel, {
    organizationId: sales.organizationId,
    branchId: sales.branchId,
    ownerUserId: sales.cashierUserId,
  });
  if (!scope) return undefined;
  const [sale] = await transaction
    .select()
    .from(sales)
    .where(
      and(
        scope,
        eq(sales.organizationId, context.organizationId),
        eq(sales.id, saleId),
        context.branch
          ? eq(sales.branchId, context.branch.branchId)
          : sql`false`,
      ),
    )
    .for("update")
    .limit(1);
  if (!sale) return undefined;
  if (sale.status !== "COMPLETED")
    throw new SalesOperationError("SALE_NOT_CANCELLABLE");
  const [updated] = await transaction
    .update(sales)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(
      and(
        eq(sales.organizationId, context.organizationId),
        eq(sales.id, saleId),
      ),
    )
    .returning();
  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    "sales.sale.cancelled",
    "sale",
    saleId,
    { reason },
  );
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "SALE_CANCELLED",
      organizationId: context.organizationId,
      branchId: sale.branchId,
      actorUserId: context.userId,
      aggregateType: "sale",
      aggregateId: saleId,
      payload: { saleId },
      metadata: { requestId },
    }),
  );
  return updated;
}

export async function recordSaleRefund(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  saleId: string,
  input: { idempotencyKey: string; amount: string; reason: string },
  requestId: string,
) {
  const scope = resourceScopePredicate(context, salesPermissions.refund, {
    organizationId: sales.organizationId,
    branchId: sales.branchId,
    ownerUserId: sales.cashierUserId,
  });
  if (!scope) return undefined;
  const requestHash = hashRequest(input);
  const [sale] = await transaction
    .select()
    .from(sales)
    .where(
      and(
        scope,
        eq(sales.organizationId, context.organizationId),
        eq(sales.id, saleId),
        context.branch
          ? eq(sales.branchId, context.branch.branchId)
          : sql`false`,
      ),
    )
    .for("update")
    .limit(1);
  if (!sale) return undefined;
  const [existingRefund] = await transaction
    .select()
    .from(saleRefunds)
    .where(
      and(
        eq(saleRefunds.organizationId, context.organizationId),
        eq(saleRefunds.saleId, sale.id),
        eq(saleRefunds.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existingRefund) {
    if (existingRefund.requestHash !== requestHash)
      throw new SalesOperationError("IDEMPOTENCY_KEY_REUSED");
    return { refund: existingRefund, replayed: true };
  }
  if (sale.status === "CANCELLED" || sale.status === "REFUNDED")
    throw new SalesOperationError("SALE_NOT_REFUNDABLE");
  const [payment] = await transaction
    .select()
    .from(salePayments)
    .where(
      and(
        eq(salePayments.organizationId, context.organizationId),
        eq(salePayments.saleId, saleId),
      ),
    )
    .limit(1);
  if (!payment) throw new SalesOperationError("PAYMENT_NOT_RECORDED");
  const [refundTotals] = await transaction
    .select({
      amount: sql<string>`coalesce(sum(${saleRefunds.amount}), 0)::text`,
    })
    .from(saleRefunds)
    .where(
      and(
        eq(saleRefunds.organizationId, context.organizationId),
        eq(saleRefunds.saleId, saleId),
      ),
    );
  const refundAmount = amountToMicros(refundTotals?.amount ?? "0");
  const paidAmount = amountToMicros(payment.amount);
  const amount = amountToMicros(input.amount);
  if (amount <= 0n || refundAmount + amount > paidAmount)
    throw new SalesOperationError("REFUND_EXCEEDS_PAID_AMOUNT");
  const [refund] = await transaction
    .insert(saleRefunds)
    .values({
      organizationId: context.organizationId,
      branchId: sale.branchId,
      saleId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      amount: input.amount,
      reason: input.reason,
      recordedByUserId: context.userId,
    })
    .onConflictDoNothing({
      target: [saleRefunds.organizationId, saleRefunds.idempotencyKey],
    })
    .returning();
  if (!refund) throw new SalesOperationError("IDEMPOTENCY_KEY_REUSED");
  const nextStatus =
    refundAmount + amount === paidAmount ? "REFUNDED" : "PARTIALLY_REFUNDED";
  await transaction
    .update(sales)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(
      and(
        eq(sales.organizationId, context.organizationId),
        eq(sales.id, saleId),
      ),
    );
  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    "sales.sale.refund_recorded",
    "sale",
    saleId,
    { amount: input.amount, reason: input.reason },
  );
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "SALE_REFUNDED",
      organizationId: context.organizationId,
      branchId: sale.branchId,
      actorUserId: context.userId,
      aggregateType: "sale",
      aggregateId: saleId,
      payload: { saleId, refundId: refund.id },
      metadata: { requestId },
    }),
  );
  return { refund, replayed: false };
}
