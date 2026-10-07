import { z } from "zod";

export const supportedLocales = ["en", "sw"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export function isSupportedLocale(value: string): boolean {
  const canonical = canonicalLocale(value);
  if (!canonical) return false;
  const language = new Intl.Locale(canonical).language;
  return supportedLocales.includes(language as SupportedLocale);
}

export function normalizeLocale(value: string): string {
  const canonical = canonicalLocale(value);
  if (!canonical || !isSupportedLocale(canonical)) {
    throw new RangeError(`Unsupported locale: ${value}`);
  }
  return canonical;
}

export const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .refine(isSupportedLocale, {
    message: `Locale language must be one of: ${supportedLocales.join(", ")}`,
  })
  .transform(normalizeLocale);

export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "Country code must be ISO-style alpha-2");

const currencyCodes =
  typeof Intl.supportedValuesOf === "function"
    ? new Set(Intl.supportedValuesOf("currency"))
    : new Set<string>();

export function isSupportedCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && currencyCodes.has(value);
}

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Currency code must be uppercase ISO 4217")
  .refine(isSupportedCurrencyCode, {
    message: "Currency code is not supported by the runtime ISO currency data",
  });

export function isValidTimeZone(value: string): boolean {
  if (value.trim() !== value || value.length === 0 || value.length > 100) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, {
    message: "Timezone must be a supported IANA timezone identifier",
  });

export const organizationRegionalSettingsSchema = z
  .object({
    countryCode: countryCodeSchema,
    currencyCode: currencyCodeSchema,
    timezone: timeZoneSchema,
    locale: localeSchema,
  })
  .strict();

export type OrganizationRegionalSettings = z.infer<
  typeof organizationRegionalSettingsSchema
>;
