import { describe, expect, it } from "vitest";
import {
  countryCodeSchema,
  currencyCodeSchema,
  isSupportedLocale,
  isValidTimeZone,
  localeSchema,
  normalizeLocale,
  organizationRegionalSettingsSchema,
  supportedLocales,
  timeZoneSchema,
} from "../src/regionalization.js";

describe("regionalization foundation", () => {
  it("normalizes supported BCP 47 locales and rejects unsupported languages", () => {
    expect(supportedLocales).toEqual(["en", "sw"]);
    expect(localeSchema.parse("EN-us")).toBe("en-US");
    expect(localeSchema.parse("sw")).toBe("sw");
    expect(isSupportedLocale("en-KE")).toBe(true);
    expect(isSupportedLocale("fr-FR")).toBe(false);
    expect(() => normalizeLocale("not_a_locale")).toThrow(RangeError);
    expect(() => localeSchema.parse("fr-FR")).toThrow();
  });

  it("validates country and runtime-supported ISO currency codes", () => {
    expect(countryCodeSchema.parse("KE")).toBe("KE");
    expect(() => countryCodeSchema.parse("KEN")).toThrow();
    expect(currencyCodeSchema.parse("KES")).toBe("KES");
    expect(currencyCodeSchema.parse("USD")).toBe("USD");
    expect(() => currencyCodeSchema.parse("ZZZ")).toThrow();
    expect(() => currencyCodeSchema.parse("kes")).toThrow();
  });

  it("validates IANA timezone identifiers without custom offset math", () => {
    expect(timeZoneSchema.parse("Africa/Nairobi")).toBe("Africa/Nairobi");
    expect(timeZoneSchema.parse("America/New_York")).toBe("America/New_York");
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/A-Timezone")).toBe(false);
  });

  it("validates the existing organization regional settings shape", () => {
    expect(
      organizationRegionalSettingsSchema.parse({
        countryCode: "KE",
        currencyCode: "KES",
        timezone: "Africa/Nairobi",
        locale: "en-KE",
      }),
    ).toEqual({
      countryCode: "KE",
      currencyCode: "KES",
      timezone: "Africa/Nairobi",
      locale: "en-KE",
    });
    expect(() =>
      organizationRegionalSettingsSchema.parse({
        countryCode: "KEN",
        currencyCode: "KES",
        timezone: "Africa/Nairobi",
        locale: "en",
      }),
    ).toThrow();
  });
});
