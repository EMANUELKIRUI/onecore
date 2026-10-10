import { z } from "zod";
import { currencyCodeSchema } from "./regionalization.js";

const customerEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(320))
  .nullable()
  .optional();

export const customerTypes = ["INDIVIDUAL", "BUSINESS"] as const;
export const customerTypeSchema = z.enum(customerTypes);
export type CustomerType = z.infer<typeof customerTypeSchema>;

export const customerStatuses = ["ACTIVE", "INACTIVE"] as const;
export const customerStatusSchema = z.enum(customerStatuses);
export type CustomerStatus = z.infer<typeof customerStatusSchema>;

export const catalogItemTypes = ["PRODUCT", "SERVICE"] as const;
export const catalogItemTypeSchema = z.enum(catalogItemTypes);
export type CatalogItemType = z.infer<typeof catalogItemTypeSchema>;

export const catalogItemStatuses = ["ACTIVE", "INACTIVE"] as const;
export const catalogItemStatusSchema = z.enum(catalogItemStatuses);
export type CatalogItemStatus = z.infer<typeof catalogItemStatusSchema>;

export const customerCreateInputSchema = z
  .object({
    branchId: z.uuid().nullable().optional(),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .toUpperCase()
      .nullable()
      .optional(),
    name: z.string().trim().min(1).max(200),
    customerType: customerTypeSchema,
    phone: z.string().trim().min(1).max(50).nullable().optional(),
    email: customerEmailSchema,
    status: customerStatusSchema.default("ACTIVE"),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export type CustomerCreateInput = z.infer<typeof customerCreateInputSchema>;

export const customerUpdateInputSchema = z
  .object({
    reference: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .toUpperCase()
      .nullable()
      .optional(),
    name: z.string().trim().min(1).max(200).optional(),
    customerType: customerTypeSchema.optional(),
    phone: z.string().trim().min(1).max(50).nullable().optional(),
    email: customerEmailSchema,
    status: customerStatusSchema.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one supported customer field is required.",
  });
export type CustomerUpdateInput = z.infer<typeof customerUpdateInputSchema>;

export const customerListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: customerStatusSchema.optional(),
    branchId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

const catalogPriceSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/, {
    message: "Price must be a non-negative decimal with up to six places.",
  });

export const catalogItemCreateInputSchema = z
  .object({
    branchId: z.uuid().nullable().optional(),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .toUpperCase()
      .nullable()
      .optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    type: catalogItemTypeSchema,
    unit: z.string().trim().min(1).max(50),
    price: catalogPriceSchema,
    currency: currencyCodeSchema,
    status: catalogItemStatusSchema.default("ACTIVE"),
  })
  .strict();
export type CatalogItemCreateInput = z.infer<
  typeof catalogItemCreateInputSchema
>;

export const catalogItemUpdateInputSchema = z
  .object({
    reference: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .toUpperCase()
      .nullable()
      .optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    type: catalogItemTypeSchema.optional(),
    unit: z.string().trim().min(1).max(50).optional(),
    price: catalogPriceSchema.optional(),
    currency: currencyCodeSchema.optional(),
    status: catalogItemStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one supported catalog field is required.",
  });
export type CatalogItemUpdateInput = z.infer<
  typeof catalogItemUpdateInputSchema
>;

export const catalogListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    type: catalogItemTypeSchema.optional(),
    status: catalogItemStatusSchema.optional(),
    branchId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type CatalogListQuery = z.infer<typeof catalogListQuerySchema>;

const saleAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);

export const salePaymentMethods = ["CASH", "MANUAL"] as const;
export const salePaymentMethodSchema = z.enum(salePaymentMethods);
export type SalePaymentMethod = z.infer<typeof salePaymentMethodSchema>;

export const saleCheckoutInputSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(128),
    customerId: z.uuid().nullable().optional(),
    items: z
      .array(
        z
          .object({
            catalogItemId: z.uuid(),
            quantity: z.number().int().min(1).max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    discountAmount: saleAmountSchema.optional(),
    paymentMethod: salePaymentMethodSchema,
    paymentReference: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();
export type SaleCheckoutInput = z.infer<typeof saleCheckoutInputSchema>;

export const saleCancellationInputSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();
export type SaleCancellationInput = z.infer<typeof saleCancellationInputSchema>;

export const saleRefundInputSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(128),
    amount: saleAmountSchema,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type SaleRefundInput = z.infer<typeof saleRefundInputSchema>;

export const saleListQuerySchema = z
  .object({
    branchId: z.uuid().optional(),
    status: z
      .enum(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "CANCELLED"])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

const amountScale = 1_000_000n;

function amountToMicros(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * amountScale + BigInt(fraction.padEnd(6, "0"));
}

function microsToAmount(amount: bigint): string {
  const whole = amount / amountScale;
  const fraction = (amount % amountScale).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export function calculateSaleAmounts(
  items: readonly { price: string; quantity: number }[],
  discountAmount: string,
  taxRateBasisPoints: number,
): { subtotal: string; discount: string; tax: string; total: string } {
  if (
    !Number.isInteger(taxRateBasisPoints) ||
    taxRateBasisPoints < 0 ||
    taxRateBasisPoints > 10_000
  ) {
    throw new RangeError("Invalid configured tax rate.");
  }
  const subtotal = items.reduce(
    (sum, item) => sum + amountToMicros(item.price) * BigInt(item.quantity),
    0n,
  );
  const discount = amountToMicros(discountAmount);
  if (discount > subtotal) throw new RangeError("Discount exceeds subtotal.");
  const taxableAmount = subtotal - discount;
  const tax = (taxableAmount * BigInt(taxRateBasisPoints) + 5_000n) / 10_000n;
  return {
    subtotal: microsToAmount(subtotal),
    discount: microsToAmount(discount),
    tax: microsToAmount(tax),
    total: microsToAmount(taxableAmount + tax),
  };
}

export interface Customer {
  id: string;
  organizationId: string;
  branchId: string | null;
  reference: string | null;
  name: string;
  customerType: CustomerType;
  phone: string | null;
  email: string | null;
  status: CustomerStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CatalogItem {
  id: string;
  organizationId: string;
  branchId: string | null;
  reference: string | null;
  name: string;
  description: string | null;
  type: CatalogItemType;
  unit: string;
  price: string;
  currency: string;
  status: CatalogItemStatus;
  createdAt: Date;
  updatedAt: Date;
}
