import { z } from "zod";

export const saleStatuses = ["OPEN", "CANCELLED"] as const;
export const saleStatusSchema = z.enum(saleStatuses);
export type SaleStatus = z.infer<typeof saleStatusSchema>;

export const saleLifecycleTransitions: Record<
  SaleStatus,
  readonly SaleStatus[]
> = {
  OPEN: ["CANCELLED"],
  CANCELLED: [],
};

export const saleCreateRequestSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            catalogItemId: z.uuid(),
            quantity: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine(({ lines }, context) => {
    const itemIds = new Set<string>();
    for (const [index, line] of lines.entries()) {
      if (itemIds.has(line.catalogItemId)) {
        context.addIssue({
          code: "custom",
          path: ["lines", index, "catalogItemId"],
          message: "Each catalog item may appear only once.",
        });
      }
      itemIds.add(line.catalogItemId);
    }
  });

export type SaleCreateRequest = z.infer<typeof saleCreateRequestSchema>;

export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);

const paginationValue = (defaultValue: number, minimum: number) =>
  z
    .string()
    .regex(/^(0|[1-9]\d{0,5})$/)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(100_000))
    .optional()
    .transform((value) => value ?? defaultValue);

export const saleListQuerySchema = z
  .object({
    limit: paginationValue(50, 1).pipe(z.number().max(100)),
    offset: paginationValue(0, 0),
  })
  .strict();

export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

const PRICE_SCALE = 1_000_000n;
export const MAX_SALE_AMOUNT_SCALED = 10n ** 26n - 1n;

export function assertSaleAmountRepresentable(amount: bigint): void {
  if (amount < 0n || amount > MAX_SALE_AMOUNT_SCALED) {
    throw new RangeError(
      "Sale amount must fit PostgreSQL numeric(26,6) precision.",
    );
  }
}

export function salePriceToScaledAmount(price: string): bigint {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(price)) {
    throw new RangeError("Sale prices must be non-negative decimals.");
  }
  const [whole, fraction = ""] = price.split(".");
  return BigInt(whole!) * PRICE_SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function formatSaleAmount(amount: bigint): string {
  assertSaleAmountRepresentable(amount);
  const whole = amount / PRICE_SCALE;
  const fraction = (amount % PRICE_SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function sumSaleAmounts(amounts: readonly bigint[]): bigint {
  let subtotal = 0n;
  for (const amount of amounts) {
    assertSaleAmountRepresentable(amount);
    subtotal += amount;
    assertSaleAmountRepresentable(subtotal);
  }
  return subtotal;
}

export function calculateSaleTotals(
  lines: readonly { unitPrice: string; quantity: number }[],
) {
  if (lines.length === 0 || lines.length > 100) {
    throw new RangeError("A sale must contain between 1 and 100 lines.");
  }
  const lineAmounts = lines.map(({ unitPrice, quantity }) => {
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 1_000_000
    ) {
      throw new RangeError("Sale quantities must be positive whole numbers.");
    }
    const amount = salePriceToScaledAmount(unitPrice) * BigInt(quantity);
    assertSaleAmountRepresentable(amount);
    return amount;
  });
  const subtotal = sumSaleAmounts(lineAmounts);
  const total = formatSaleAmount(subtotal);
  return {
    lines: lineAmounts.map((amount) => ({
      lineTotal: formatSaleAmount(amount),
    })),
    subtotal: total,
    total,
  };
}
