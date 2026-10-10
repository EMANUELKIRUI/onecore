import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  createDomainEvent,
  type InventoryAdjustmentInput,
  type InventoryStockQuery,
} from "@onecore/core-domain";
import type { ResolvedAuthorizationContext } from "./authorization.js";
import { writeAuthorizationMutationEvent } from "./authorization.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import { recordOutboxEvent } from "./outbox.js";
import {
  catalogItems,
  inventoryMovements,
  inventoryReservations,
  inventoryStockBalances,
} from "../schema/index.js";
import {
  resourceScopeAllowsCreate,
  resourceScopePredicate,
} from "./resource-authorization.js";

const stockReadPermission = "core.inventory.stock.read";
const stockAdjustPermission = "core.inventory.stock.adjust";
const stockReleasePermission = "core.inventory.stock.release";

export type InventoryAdjustmentOutcome =
  | { outcome: "CREATED" | "EXISTING"; movementId: string; stock: StockBalance }
  | { outcome: "IDEMPOTENCY_CONFLICT" | "CATALOG_ITEM_UNAVAILABLE" | "INSUFFICIENT_STOCK" | "FORBIDDEN" };

export interface StockBalance {
  catalogItemId: string;
  itemType: "PRODUCT" | "SERVICE";
  tracked: boolean;
  onHand: number | null;
  reserved: number | null;
  available: number | null;
}

export interface SaleStockLine {
  catalogItemId: string;
  itemType: "PRODUCT" | "SERVICE";
  quantity: number;
}

function hasPermissionScope(
  context: ResolvedAuthorizationContext,
  permission: string,
): boolean {
  return context.permissions.some(
    ({ key, scopeType }) =>
      key === permission && (scopeType === "ORGANIZATION" || scopeType === "BRANCH"),
  );
}

async function setActorContext(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
): Promise<void> {
  await transaction.execute(
    sql`SELECT set_config('app.current_user_id', ${context.userId}, true)`,
  );
}

function movementHash(input: {
  organizationId: string;
  branchId: string;
  userId: string;
  catalogItemId: string;
  movementType: string;
  delta: number;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function recordMovementEvent(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  movement: {
    id: string;
    catalogItemId: string;
    movementType: "RECEIPT" | "ADJUSTMENT" | "RESERVATION" | "RESERVATION_RELEASE";
  },
): Promise<void> {
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "INVENTORY_STOCK_CHANGED",
      organizationId: context.organizationId,
      branchId: context.branchId!,
      actorUserId: context.userId,
      aggregateType: "inventory_stock_balance",
      aggregateId: movement.catalogItemId,
      payload: {
        movementId: movement.id,
        catalogItemId: movement.catalogItemId,
        movementType: movement.movementType,
      },
      metadata: { requestId },
    }),
  );
  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    `INVENTORY_${movement.movementType}`,
    "inventory_movement",
    movement.id,
    { catalogItemId: movement.catalogItemId },
  );
}

export async function listBranchStock(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  query: InventoryStockQuery,
): Promise<StockBalance[] | undefined> {
  const branchId = context.branchId;
  const scope = resourceScopePredicate(context, stockReadPermission, {
    organizationId: inventoryStockBalances.organizationId,
    branchId: inventoryStockBalances.branchId,
  });
  if (!branchId || !scope) return undefined;

  const items = await transaction
    .select({
      id: catalogItems.id,
      type: catalogItems.type,
    })
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.organizationId, context.organizationId),
        inArray(catalogItems.id, query.catalogItemIds),
        eq(catalogItems.status, "ACTIVE"),
        sql`(${catalogItems.branchId} IS NULL OR ${catalogItems.branchId} = ${branchId})`,
      ),
    );
  const itemIds = items.map(({ id }) => id);
  const balances = itemIds.length
    ? await transaction
        .select({
          catalogItemId: inventoryStockBalances.catalogItemId,
          onHand: inventoryStockBalances.onHand,
          reserved: inventoryStockBalances.reserved,
        })
        .from(inventoryStockBalances)
        .where(
          and(
            scope,
            eq(inventoryStockBalances.organizationId, context.organizationId),
            eq(inventoryStockBalances.branchId, branchId),
            inArray(inventoryStockBalances.catalogItemId, itemIds),
          ),
        )
    : [];
  const balanceByItem = new Map(
    balances.map((balance) => [balance.catalogItemId, balance]),
  );
  return items.map((item) => {
    if (item.type === "SERVICE") {
      return {
        catalogItemId: item.id,
        itemType: "SERVICE",
        tracked: false,
        onHand: null,
        reserved: null,
        available: null,
      };
    }
    const balance = balanceByItem.get(item.id);
    const onHand = balance?.onHand ?? 0;
    const reserved = balance?.reserved ?? 0;
    return {
      catalogItemId: item.id,
      itemType: "PRODUCT",
      tracked: true,
      onHand,
      reserved,
      available: onHand - reserved,
    };
  });
}

export class InsufficientStockError extends Error {
  constructor() {
    super("Insufficient available stock for this branch.");
    this.name = "InsufficientStockError";
  }
}

function hasInsufficientStockCause(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  if (
    typeof candidate.message === "string" &&
    candidate.message.includes("INSUFFICIENT_AVAILABLE_STOCK")
  ) {
    return true;
  }
  return candidate.cause !== undefined
    ? hasInsufficientStockCause(candidate.cause, depth + 1)
    : false;
}

export async function createSaleReservations(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  saleId: string,
  lines: readonly SaleStockLine[],
  requestId: string,
): Promise<void> {
  const branchId = context.branchId;
  if (!branchId) throw new Error("Verified branch is required for reservations");
  await setActorContext(transaction, context);
  const products = lines
    .filter((line) => line.itemType === "PRODUCT")
    .sort((left, right) => left.catalogItemId.localeCompare(right.catalogItemId));
  for (const line of products) {
    let reservation: { id: string } | undefined;
    try {
      [reservation] = await transaction
        .insert(inventoryReservations)
        .values({
          organizationId: context.organizationId,
          branchId,
          saleId,
          catalogItemId: line.catalogItemId,
          quantity: line.quantity,
        })
        .returning({ id: inventoryReservations.id });
    } catch (error) {
      if (hasInsufficientStockCause(error)) throw new InsufficientStockError();
      throw error;
    }
    if (!reservation) throw new Error("Inventory reservation insert failed");
    const [movement] = await transaction
      .select({
        id: inventoryMovements.id,
        catalogItemId: inventoryMovements.catalogItemId,
        movementType: inventoryMovements.movementType,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, context.organizationId),
          eq(inventoryMovements.reservationId, reservation.id),
          eq(inventoryMovements.movementType, "RESERVATION"),
        ),
      )
      .limit(1);
    if (!movement) throw new Error("Reservation movement was not recorded");
    await recordMovementEvent(transaction, context, requestId, movement);
  }
}

export async function releaseSaleReservations(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  saleId: string,
  requestId: string,
): Promise<number> {
  const branchId = context.branchId;
  if (
    !branchId ||
    !resourceScopeAllowsCreate(context, stockReleasePermission, {
      organizationId: context.organizationId,
      branchId,
      ownerUserId: context.userId,
    })
  ) {
    throw new Error("Inventory release permission is required");
  }
  await setActorContext(transaction, context);
  const active = await transaction
    .select({ id: inventoryReservations.id, catalogItemId: inventoryReservations.catalogItemId })
    .from(inventoryReservations)
    .where(
      and(
        eq(inventoryReservations.organizationId, context.organizationId),
        eq(inventoryReservations.branchId, branchId),
        eq(inventoryReservations.saleId, saleId),
        eq(inventoryReservations.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(inventoryReservations.catalogItemId))
    .for("update");

  for (const reservation of active) {
    await transaction
      .update(inventoryReservations)
      .set({
        status: "RELEASED",
        releasedAt: new Date(),
        releasedByUserId: context.userId,
      })
      .where(
        and(
          eq(inventoryReservations.organizationId, context.organizationId),
          eq(inventoryReservations.id, reservation.id),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
    const [movement] = await transaction
      .select({
        id: inventoryMovements.id,
        catalogItemId: inventoryMovements.catalogItemId,
        movementType: inventoryMovements.movementType,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, context.organizationId),
          eq(inventoryMovements.reservationId, reservation.id),
          eq(inventoryMovements.movementType, "RESERVATION_RELEASE"),
        ),
      )
      .limit(1);
    if (!movement) throw new Error("Reservation release movement was not recorded");
    await recordMovementEvent(transaction, context, requestId, movement);
  }
  return active.length;
}

export async function adjustBranchStock(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  input: InventoryAdjustmentInput,
  idempotencyKey: string,
  requestId: string,
): Promise<InventoryAdjustmentOutcome> {
  const branchId = context.branchId;
  if (
    !branchId ||
    !resourceScopeAllowsCreate(context, stockAdjustPermission, {
      organizationId: context.organizationId,
      branchId,
      ownerUserId: context.userId,
    })
  ) {
    return { outcome: "FORBIDDEN" };
  }
  const [item] = await transaction
    .select({ id: catalogItems.id, type: catalogItems.type, status: catalogItems.status, branchId: catalogItems.branchId })
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.organizationId, context.organizationId),
        eq(catalogItems.id, input.catalogItemId),
      ),
    )
    .for("share")
    .limit(1);
  if (
    !item ||
    item.type !== "PRODUCT" ||
    item.status !== "ACTIVE" ||
    (item.branchId !== null && item.branchId !== branchId)
  ) {
    return { outcome: "CATALOG_ITEM_UNAVAILABLE" };
  }

  await setActorContext(transaction, context);
  await transaction.execute(sql`
    INSERT INTO inventory_stock_balances (organization_id, branch_id, catalog_item_id)
    VALUES (${context.organizationId}, ${branchId}, ${input.catalogItemId})
    ON CONFLICT (organization_id, branch_id, catalog_item_id) DO NOTHING
  `);
  const [balance] = await transaction
    .select()
    .from(inventoryStockBalances)
    .where(
      and(
        eq(inventoryStockBalances.organizationId, context.organizationId),
        eq(inventoryStockBalances.branchId, branchId),
        eq(inventoryStockBalances.catalogItemId, input.catalogItemId),
      ),
    )
    .limit(1);
  if (!balance) throw new Error("Inventory balance was not initialized");
  if (balance.onHand + input.delta < balance.reserved) {
    return { outcome: "INSUFFICIENT_STOCK" };
  }

  const requestHash = movementHash({
    organizationId: context.organizationId,
    branchId,
    userId: context.userId,
    catalogItemId: input.catalogItemId,
    movementType: input.movementType,
    delta: input.delta,
  });
  const [existing] = await transaction
    .select({ id: inventoryMovements.id, requestHash: inventoryMovements.requestHash })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, context.organizationId),
        eq(inventoryMovements.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.requestHash !== requestHash) return { outcome: "IDEMPOTENCY_CONFLICT" };
    return {
      outcome: "EXISTING",
      movementId: existing.id,
      stock: {
        catalogItemId: input.catalogItemId,
        itemType: "PRODUCT",
        tracked: true,
        onHand: balance.onHand,
        reserved: balance.reserved,
        available: balance.onHand - balance.reserved,
      },
    };
  }

  const [movement] = await transaction
    .insert(inventoryMovements)
    .values({
      organizationId: context.organizationId,
      branchId,
      catalogItemId: input.catalogItemId,
      saleId: null,
      reservationId: null,
      movementType: input.movementType,
      deltaOnHand: input.delta,
      deltaReserved: 0,
      idempotencyKey,
      requestHash,
      actorUserId: context.userId,
    })
    .onConflictDoNothing({
      target: [inventoryMovements.organizationId, inventoryMovements.idempotencyKey],
    })
    .returning({ id: inventoryMovements.id });
  if (!movement) {
    const [raceWinner] = await transaction
      .select({ id: inventoryMovements.id, requestHash: inventoryMovements.requestHash })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, context.organizationId),
          eq(inventoryMovements.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!raceWinner || raceWinner.requestHash !== requestHash) {
      return { outcome: "IDEMPOTENCY_CONFLICT" };
    }
    return {
      outcome: "EXISTING",
      movementId: raceWinner.id,
      stock: {
        catalogItemId: input.catalogItemId,
        itemType: "PRODUCT",
        tracked: true,
        onHand: balance.onHand,
        reserved: balance.reserved,
        available: balance.onHand - balance.reserved,
      },
    };
  }

  await recordMovementEvent(transaction, context, requestId, {
    id: movement.id,
    catalogItemId: input.catalogItemId,
    movementType: input.movementType,
  });
  const [updated] = await transaction
    .select()
    .from(inventoryStockBalances)
    .where(
      and(
        eq(inventoryStockBalances.organizationId, context.organizationId),
        eq(inventoryStockBalances.branchId, branchId),
        eq(inventoryStockBalances.catalogItemId, input.catalogItemId),
      ),
    )
    .limit(1);
  if (!updated) throw new Error("Updated inventory balance was not found");
  return {
    outcome: "CREATED",
    movementId: movement.id,
    stock: {
      catalogItemId: input.catalogItemId,
      itemType: "PRODUCT",
      tracked: true,
      onHand: updated.onHand,
      reserved: updated.reserved,
      available: updated.onHand - updated.reserved,
    },
  };
}
