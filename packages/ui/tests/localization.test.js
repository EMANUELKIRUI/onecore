import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercentage,
  formatTime,
  resolveLocale,
  translate,
} from "../src/localization.js";

describe("shared localization utilities", () => {
  it("resolves supported locales and falls back for invalid or unsupported values", () => {
    expect(resolveLocale("EN-us")).toBe("en-US");
    expect(resolveLocale("sw-KE")).toBe("sw-KE");
    expect(resolveLocale("fr-FR")).toBe("en");
    expect(resolveLocale("fr-FR", "sw")).toBe("sw");
    expect(resolveLocale("invalid", "invalid")).toBe("en");
  });

  it("looks up regional and language translations before explicit fallback text", () => {
    const messages = {
      en: { greeting: "english catalog fixture" },
      sw: { greeting: "language fallback fixture" },
      "sw-KE": { greeting: "regional catalog fixture" },
    };

    expect(
      translate("greeting", {
        locale: "sw-KE",
        messages,
        fallbackText: "Welcome",
      }),
    ).toBe("regional catalog fixture");
    expect(
      translate("missing", {
        locale: "sw",
        messages,
        fallbackText: "Welcome",
      }),
    ).toBe("Welcome");
    expect(
      translate("greeting", {
        locale: "fr-FR",
        fallbackLocale: "sw",
        messages,
        fallbackText: "Welcome",
      }),
    ).toBe("language fallback fixture");
    expect(() => translate("missing")).toThrow(TypeError);
  });

  it("formats instants deterministically by locale and configured timezone", () => {
    const instant = new Date("2024-01-15T12:30:00.000Z");
    expect(formatDate(instant, { locale: "en", timeZone: "UTC" })).toBe(
      "Jan 15, 2024",
    );
    expect(formatDateTime(instant, { locale: "en", timeZone: "UTC" })).toBe(
      "Jan 15, 2024, 12:30 PM",
    );
    expect(
      formatTime(instant, { locale: "en", timeZone: "Africa/Nairobi" }),
    ).toBe("3:30 PM");
    expect(formatDate(instant, { locale: "en-GB", timeZone: "UTC" })).toBe(
      "15 Jan 2024",
    );
    expect(() => formatDate("2024-01-15")).toThrow(TypeError);
    expect(() => formatDate(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => formatTime(instant, { timeZone: "Not/A-Timezone" })).toThrow(
      RangeError,
    );
  });

  it("formats numbers, percentages, and currencies using native Intl conventions", () => {
    expect(formatNumber(1234.5, { locale: "en-US" })).toBe("1,234.5");
    expect(
      formatNumber(1234.5, {
        locale: "de-DE",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    ).toBe("1.234,50");
    expect(formatPercentage(0.125, { locale: "en-US" })).toBe("13%");
    expect(formatCurrency(12500.5, "KES", { locale: "en-KE" })).toBe(
      new Intl.NumberFormat("en-KE", {
        style: "currency",
        currency: "KES",
      }).format(12500.5),
    );
    expect(() => formatNumber(Number.NaN)).toThrow(TypeError);
    expect(() => formatCurrency(10, "KES")).not.toThrow();
    expect(() => formatCurrency(10, "kes")).toThrow(RangeError);
    expect(() => formatCurrency(10, "ZZZ")).toThrow(RangeError);
  });
});
