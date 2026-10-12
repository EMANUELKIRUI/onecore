import { z } from "zod";

export const inventoryMovementTypes = [
  "RECEIPT",
  "ADJUSTMENT",
  "RESERVATION",
  "RESERVATION_RELEASE",
] as const;
export const inventoryMovementTypeSchema = z.enum(inventoryMovementTypes);
export type InventoryMovementType = z.infer<typeof inventoryMovementTypeSchema>;

export const inventoryReservationStatuses = ["ACTIVE", "RELEASED"] as const;
export const inventoryReservationStatusSchema = z.enum(
  inventoryReservationStatuses,
);
export type InventoryReservationStatus = z.infer<
  typeof inventoryReservationStatusSchema
>;

export const inventoryStockQuerySchema = z
  .object({
    catalogItemId: z.union([z.uuid(), z.array(z.uuid()).min(1).max(100)]),
  })
  .strict()
  .transform(({ catalogItemId }) => ({
    catalogItemIds: Array.isArray(catalogItemId)
      ? [...new Set(catalogItemId)]
      : [catalogItemId],
  }));

export type InventoryStockQuery = z.infer<typeof inventoryStockQuerySchema>;

export const inventoryAdjustmentInputSchema = z
  .object({
    catalogItemId: z.uuid(),
    movementType: z.enum(["RECEIPT", "ADJUSTMENT"]),
    delta: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((value) => value !== 0),
  })
  .strict()
  .refine(
    ({ movementType, delta }) => movementType !== "RECEIPT" || delta > 0,
    { path: ["delta"], message: "Receipts must add a positive quantity." },
  );

export type InventoryAdjustmentInput = z.infer<
  typeof inventoryAdjustmentInputSchema
>;
