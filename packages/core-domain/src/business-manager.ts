import { z } from "zod";
import { countryCodeSchema, currencyCodeSchema } from "./regionalization.js";

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

export const businessProfilePatchSchema = z
  .object({
    contactEmail: customerEmailSchema,
    contactPhone: z.string().trim().min(1).max(50).nullable().optional(),
    website: z.url().max(2_048).nullable().optional(),
    countryCode: countryCodeSchema.nullable().optional(),
    region: z.string().trim().min(1).max(100).nullable().optional(),
    city: z.string().trim().min(1).max(100).nullable().optional(),
    address: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one supported business profile field is required.",
  });
export type BusinessProfilePatch = z.infer<typeof businessProfilePatchSchema>;

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
export const catalogPriceInputSchema = catalogPriceSchema;

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
