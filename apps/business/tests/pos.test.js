import { describe, expect, it, vi } from "vitest";
import {
  addDraftCartItem,
  catalogPriceToScaledAmount,
  createSaleCheckoutController,
  draftCartSubtotal,
  formatScaledAmount,
  parseDraftQuantity,
  removeDraftCartItem,
  saleCheckoutMessage,
  setDraftCartQuantity,
} from "../pos.js";

const organizationId = "00000000-0000-4000-8000-000000000101";
const branchId = "00000000-0000-4000-8000-000000000102";
const userId = "00000000-0000-4000-8000-000000000103";
const itemId = "00000000-0000-4000-8000-000000000001";
const secondItemId = "00000000-0000-4000-8000-000000000002";
const context = { organizationId, userId, branchId };

const catalogItem = (overrides = {}) => ({
  id: itemId,
  name: "Tea",
  reference: "TEA-001",
  type: "PRODUCT",
  unit: "box",
  price: "12.340005",
  currency: "KES",
  status: "ACTIVE",
  ...overrides,
});

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function createController(request, storage = new MemoryStorage()) {
  return {
    storage,
    controller: createSaleCheckoutController({
      storage,
      request,
      createKey: () => "sales-checkout-key-1",
    }),
  };
}

function validResponse(request, serverUnitPrice = "12.340001") {
  const [whole, fraction = ""] = serverUnitPrice.split(".");
  const unitPriceScaled =
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const lines = request.lines.map((line) => {
    const lineTotalScaled = unitPriceScaled * BigInt(line.quantity);
    const wholeTotal = lineTotalScaled / 1_000_000n;
    const fractionTotal = (lineTotalScaled % 1_000_000n)
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "");
    return {
      catalogItemId: line.catalogItemId,
      quantity: line.quantity,
      itemName: "Server catalog item",
      unitPrice: serverUnitPrice,
      lineTotal: fractionTotal
        ? `${wholeTotal}.${fractionTotal}`
        : String(wholeTotal),
    };
  });
  const subtotalScaled = lines.reduce((sum, line) => {
    const [lineWhole, lineFraction = ""] = line.lineTotal.split(".");
    return (
      sum + BigInt(lineWhole) * 1_000_000n + BigInt(lineFraction.padEnd(6, "0"))
    );
  }, 0n);
  const wholeSubtotal = subtotalScaled / 1_000_000n;
  const fractionSubtotal = (subtotalScaled % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  const subtotal = fractionSubtotal
    ? `${wholeSubtotal}.${fractionSubtotal}`
    : String(wholeSubtotal);
  return {
    sale: {
      id: "00000000-0000-4000-8000-000000000201",
      organizationId,
      branchId,
      status: "OPEN",
      currency: "KES",
      subtotal,
      total: subtotal,
      lines,
    },
  };
}

function pendingAttempt(storage) {
  return JSON.parse(storage.getItem("onecore.sales.pending-checkout"));
}

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

  it("accepts only positive quantities within the API limit", () => {
    expect(parseDraftQuantity("1")).toBe(1);
    expect(parseDraftQuantity("1000000")).toBe(1_000_000);
    for (const value of ["", "0", "-1", "1.5", "01", "1000001"]) {
      expect(parseDraftQuantity(value)).toBeNull();
    }
  });

  it("adds active catalog items, merges quantities, and blocks mixed currency", () => {
    const cart = new Map();
    expect(addDraftCartItem(cart, catalogItem())).toBe(true);
    expect(addDraftCartItem(cart, catalogItem())).toBe(true);
    expect(cart.get(itemId).quantity).toBe(2);
    expect(
      addDraftCartItem(
        cart,
        catalogItem({ id: secondItemId, currency: "USD" }),
      ),
    ).toBe(false);
    expect(cart.has(secondItemId)).toBe(false);
    expect(() =>
      addDraftCartItem(cart, catalogItem({ status: "INACTIVE" })),
    ).toThrow(TypeError);
  });

  it("validates quantity updates and totals drafts without float loss", () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    addDraftCartItem(
      cart,
      catalogItem({ id: secondItemId, name: "Coffee", price: "0.000001" }),
    );
    expect(setDraftCartQuantity(cart, itemId, "3")).toBe(true);
    expect(setDraftCartQuantity(cart, itemId, "0")).toBe(false);
    expect(draftCartSubtotal(cart)).toEqual({
      currency: "KES",
      amount: 37_020_016n,
    });
    expect(formatScaledAmount(draftCartSubtotal(cart).amount)).toBe(
      "37.020016",
    );
    expect(removeDraftCartItem(cart, secondItemId)).toBe(true);
    expect(removeDraftCartItem(cart, "missing")).toBe(false);
  });
});

describe("POS Sales checkout", () => {
  it("sends only catalog IDs and integer quantities to the verified endpoint", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    setDraftCartQuantity(cart, itemId, "3");
    const request = vi.fn(async (_path, options) =>
      validResponse(options.body),
    );
    const { controller } = createController(request);

    const result = await controller.submit(cart, context);

    expect(request).toHaveBeenCalledWith(
      `/organizations/${organizationId}/sales`,
      expect.objectContaining({
        method: "POST",
        headers: { "Idempotency-Key": "sales-checkout-key-1" },
        body: { lines: [{ catalogItemId: itemId, quantity: 3 }] },
        expectedStatus: 201,
      }),
    );
    expect(request.mock.calls[0][1].body).not.toHaveProperty("total");
    expect(request.mock.calls[0][1].body.lines[0]).not.toHaveProperty("price");
    expect(result.kind).toBe("SUCCESS");
  });

  it("uses server-returned prices and totals instead of local estimates", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem({ price: "1.25" }));
    const { controller } = createController(async (_path, options) =>
      validResponse(options.body, "24.680002"),
    );

    const result = await controller.submit(cart, context);

    expect(result.sale.total).toBe("24.680002");
    expect(result.sale.lines[0]).toMatchObject({
      unitPrice: "24.680002",
      lineTotal: "24.680002",
    });
    expect(formatScaledAmount(draftCartSubtotal(cart).amount)).toBe("1.25");
  });

  it("accepts only a valid unpaid OPEN sale and clears its saved attempt", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const { controller, storage } = createController(async (_path, options) =>
      validResponse(options.body),
    );

    const result = await controller.submit(cart, context);

    expect(result).toMatchObject({ kind: "SUCCESS", sale: { status: "OPEN" } });
    expect(storage.getItem("onecore.sales.pending-checkout")).toBeNull();
  });

  it("preserves the cart when a request is rejected", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const { controller } = createController(async () => {
      throw { status: 403, code: "FORBIDDEN", message: "private details" };
    });

    const result = await controller.submit(cart, context);

    expect(cart.get(itemId).quantity).toBe(1);
    expect(result.kind).toBe("REJECTED");
  });

  it("prevents simultaneous requests from repeated checkout clicks", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    let resolveRequest;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { controller } = createController(request);

    const first = controller.submit(cart, context);
    const second = await controller.submit(cart, context);
    resolveRequest(
      validResponse({ lines: [{ catalogItemId: itemId, quantity: 1 }] }),
    );

    expect(second.kind).toBe("IN_PROGRESS");
    expect(request).toHaveBeenCalledTimes(1);
    await first;
  });

  it("retains and reuses the same key after a network failure", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const storage = new MemoryStorage();
    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 0, code: "NETWORK_ERROR" })
      .mockImplementationOnce(async (_path, options) =>
        validResponse(options.body),
      );
    const { controller } = createController(request, storage);

    expect((await controller.submit(cart, context)).kind).toBe("UNCERTAIN");
    expect(pendingAttempt(storage)).toMatchObject({
      key: "sales-checkout-key-1",
      status: "UNCERTAIN",
      request: { lines: [{ catalogItemId: itemId, quantity: 1 }] },
    });
    expect((await controller.submit(cart, context)).kind).toBe("SUCCESS");
    expect(request.mock.calls[0][1].headers).toEqual(
      request.mock.calls[1][1].headers,
    );
    expect(request.mock.calls[0][1].body).toEqual(
      request.mock.calls[1][1].body,
    );
  });

  it("retries the saved request after reload without generating a new key", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const storage = new MemoryStorage();
    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 0, code: "NETWORK_ERROR" })
      .mockImplementationOnce(async (_path, options) =>
        validResponse(options.body),
      );
    const firstController = createSaleCheckoutController({
      storage,
      request,
      createKey: () => "original-checkout-key",
    });
    await firstController.submit(cart, context);
    const createKey = vi.fn(() => "new-checkout-key-must-not-be-used");
    const reloadedController = createSaleCheckoutController({
      storage,
      request,
      createKey,
    });

    const result = await reloadedController.submit(new Map(), context);

    expect(result.kind).toBe("SUCCESS");
    expect(createKey).not.toHaveBeenCalled();
    expect(request.mock.calls[0][1].headers).toEqual({
      "Idempotency-Key": "original-checkout-key",
    });
    expect(request.mock.calls[0][1].body).toEqual(
      request.mock.calls[1][1].body,
    );
  });

  it("blocks a changed cart from reusing a pending key", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const request = vi.fn().mockRejectedValue({ status: 0 });
    const { controller } = createController(request);
    await controller.submit(cart, context);
    const changedCart = new Map([
      [secondItemId, { ...catalogItem({ id: secondItemId }), quantity: 1 }],
    ]);

    const result = await controller.submit(changedCart, context);

    expect(result.kind).toBe("MISMATCH");
    expect(request).toHaveBeenCalledTimes(1);
    expect(saleCheckoutMessage(result)).toMatch(/original attempt/);
  });

  it("shows authorization failures without exposing server details", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const { controller } = createController(async () => {
      throw {
        status: 403,
        code: "FORBIDDEN",
        message: "database stack, token=secret",
      };
    });

    const result = await controller.submit(cart, context);
    const message = saleCheckoutMessage(result);

    expect(message).toContain("not authorized");
    expect(message).not.toMatch(/database|stack|token|secret/i);
  });

  it("blocks an idempotency conflict instead of silently creating a new attempt", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const request = vi.fn(async () => {
      throw { status: 409, code: "CONFLICT" };
    });
    const { controller, storage } = createController(request);

    const first = await controller.submit(cart, context);
    const second = await controller.submit(cart, context);

    expect(first.kind).toBe("CONFLICT");
    expect(second.kind).toBe("CONFLICT");
    expect(request).toHaveBeenCalledTimes(1);
    expect(pendingAttempt(storage).status).toBe("CONFLICT");
  });

  it("does not report success for a malformed response", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const { controller, storage } = createController(async () => ({
      sale: {},
    }));

    const result = await controller.submit(cart, context);

    expect(result.kind).toBe("UNCERTAIN");
    expect(saleCheckoutMessage(result)).toMatch(/unexpected response/);
    expect(pendingAttempt(storage).status).toBe("UNCERTAIN");
  });

  it("uses the authenticated organization and branch, never request-body overrides", async () => {
    const cart = new Map();
    addDraftCartItem(cart, catalogItem());
    const request = vi.fn(async (_path, options) =>
      validResponse(options.body),
    );
    const { controller } = createController(request);

    await controller.submit(cart, context);

    expect(request.mock.calls[0][0]).toBe(
      `/organizations/${organizationId}/sales`,
    );
    expect(request.mock.calls[0][1].body).not.toHaveProperty("organizationId");
    expect(request.mock.calls[0][1].body).not.toHaveProperty("branchId");
  });
});
