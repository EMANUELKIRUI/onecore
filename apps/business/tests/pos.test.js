import { describe, expect, it } from "vitest";
import {
  addDraftCartItem,
  catalogPriceToScaledAmount,
  draftCartSubtotal,
  formatScaledAmount,
  parseDraftQuantity,
  removeDraftCartItem,
  setDraftCartQuantity,
} from "../pos.js";

const catalogItem = (overrides = {}) => ({
  id: "item-1",
  name: "Tea",
  reference: "TEA-001",
  type: "PRODUCT",
  unit: "box",
  price: "12.340005",
  currency: "KES",
  status: "ACTIVE",
  ...overrides,
});

describe("POS draft cart helpers", () => {
  it("parses and formats catalog decimals exactly to six places", () => {
    expect(catalogPriceToScaledAmount("12.340005")).toBe(12_340_005n);
    expect(formatScaledAmount(12_340_005n)).toBe("12.340005");
    expect(formatScaledAmount(catalogPriceToScaledAmount("10.50"))).toBe(
      "10.5",
    );
    expect(() => catalogPriceToScaledAmount("1.0000001")).toThrow(RangeError);
    expect(() => catalogPriceToScaledAmount("-1")).toThrow(RangeError);
  });

  it("accepts only positive safe-integer quantities", () => {
    expect(parseDraftQuantity("1")).toBe(1);
    expect(parseDraftQuantity("9007199254740991")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of ["", "0", "-1", "1.5", "01", "9007199254740992"]) {
      expect(parseDraftQuantity(value)).toBeNull();
    }
  });

  it("adds active catalog items, merges quantities, and blocks mixed currency", () => {
    const cart = new Map();
    expect(addDraftCartItem(cart, catalogItem())).toBe(true);
    expect(addDraftCartItem(cart, catalogItem())).toBe(true);
    expect(cart.get("item-1").quantity).toBe(2);
    expect(
      addDraftCartItem(cart, catalogItem({ id: "item-2", currency: "USD" })),
    ).toBe(false);
    expect(cart.has("item-2")).toBe(false);
    expect(() =>
      addDraftCartItem(cart, catalogItem({ status: "INACTIVE" })),
    ).toThrow(TypeError);
  });

  it("validates quantity updates and totals the draft without floating-point loss", () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    addDraftCartItem(
      cart,
      catalogItem({ id: "item-2", name: "Coffee", price: "0.000001" }),
    );
    expect(setDraftCartQuantity(cart, "item-1", "3")).toBe(true);
    expect(setDraftCartQuantity(cart, "item-1", "0")).toBe(false);
    expect(draftCartSubtotal(cart)).toEqual({
      currency: "KES",
      amount: 37_020_016n,
    });
    expect(formatScaledAmount(draftCartSubtotal(cart).amount)).toBe(
      "37.020016",
    );
    expect(removeDraftCartItem(cart, "item-2")).toBe(true);
    expect(removeDraftCartItem(cart, "missing")).toBe(false);
  });

  it("returns no subtotal for an empty cart", () => {
    expect(draftCartSubtotal(new Map())).toBeNull();
  });
});
