import { describe, expect, it, vi } from "vitest";
import {
  createInventoryMovementController,
  inventoryMovementMessage,
} from "../inventory.js";

const organizationId = "00000000-0000-4000-8000-000000000101";
const branchId = "00000000-0000-4000-8000-000000000102";
const userId = "00000000-0000-4000-8000-000000000103";
const catalogItemId = "00000000-0000-4000-8000-000000000104";
const context = { organizationId, branchId, userId };
const receipt = { catalogItemId, movementType: "RECEIPT", delta: 5 };

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

function stockResponse(overrides = {}) {
  return {
    movementId: "00000000-0000-4000-8000-000000000201",
    stock: {
      catalogItemId,
      itemType: "PRODUCT",
      tracked: true,
      onHand: 5,
      reserved: 0,
      available: 5,
      ...overrides,
    },
  };
}

describe("inventory movement controller", () => {
  it("sends a validated receipt with the idempotency key and clears confirmed state", async () => {
    const storage = new MemoryStorage();
    const request = vi.fn(async () => stockResponse());
    const controller = createInventoryMovementController({
      storage,
      request,
      createKey: () => "inventory-movement-key-1",
    });

    const result = await controller.submit(receipt, context);

    expect(request).toHaveBeenCalledWith(
      `/organizations/${organizationId}/inventory/stock`,
      expect.objectContaining({
        method: "POST",
        headers: { "Idempotency-Key": "inventory-movement-key-1" },
        body: receipt,
      }),
    );
    expect(result).toMatchObject({ kind: "SUCCESS", stock: { available: 5 } });
    expect(controller.getState(context)).toEqual({ kind: "NONE" });
  });

  it("reuses the exact key and movement after an uncertain response or reload", async () => {
    const storage = new MemoryStorage();
    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 0, code: "NETWORK_ERROR" })
      .mockImplementationOnce(async () => stockResponse());
    const createKey = vi.fn(() => "inventory-movement-key-2");
    const firstController = createInventoryMovementController({
      storage,
      request,
      createKey,
    });

    expect((await firstController.submit(receipt, context)).kind).toBe(
      "UNCERTAIN",
    );
    expect(firstController.getState(context).kind).toBe("UNCERTAIN");
    const reloadedController = createInventoryMovementController({
      storage,
      request,
      createKey,
    });
    expect((await reloadedController.submit(receipt, context)).kind).toBe(
      "SUCCESS",
    );
    expect(createKey).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1].headers).toEqual(
      request.mock.calls[1]?.[1].headers,
    );
    expect(request.mock.calls[0]?.[1].body).toEqual(
      request.mock.calls[1]?.[1].body,
    );
  });

  it("blocks changed input and a different organization or branch while the original result is uncertain", async () => {
    const storage = new MemoryStorage();
    const request = vi.fn().mockRejectedValue({ status: 0 });
    const controller = createInventoryMovementController({ storage, request });
    await controller.submit(receipt, context);

    expect(
      await controller.submit({ ...receipt, delta: 6 }, context),
    ).toMatchObject({ kind: "MISMATCH" });
    expect(
      await controller.submit(receipt, {
        ...context,
        branchId: "00000000-0000-4000-8000-000000000105",
      }),
    ).toMatchObject({ kind: "OTHER_CONTEXT" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid quantities and prevents concurrent requests", async () => {
    const storage = new MemoryStorage();
    let resolveRequest;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const controller = createInventoryMovementController({ storage, request });

    expect(
      await controller.submit({ ...receipt, movementType: "ADJUSTMENT", delta: 0 }, context),
    ).toMatchObject({ kind: "INVALID_MOVEMENT" });
    const first = controller.submit(receipt, context);
    await expect(controller.submit(receipt, context)).resolves.toMatchObject({
      kind: "IN_PROGRESS",
    });
    resolveRequest(stockResponse());
    await expect(first).resolves.toMatchObject({ kind: "SUCCESS" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps insufficient stock and authorization failures to safe messages", async () => {
    const controller = createInventoryMovementController({
      storage: new MemoryStorage(),
      request: async () => {
        throw { status: 409, code: "INSUFFICIENT_STOCK" };
      },
    });
    const result = await controller.submit(
      { catalogItemId, movementType: "ADJUSTMENT", delta: -3 },
      context,
    );

    expect(result).toMatchObject({ kind: "REJECTED", status: 409 });
    expect(inventoryMovementMessage(result)).toMatch(/reservations/);
    expect(inventoryMovementMessage({ kind: "REJECTED", status: 403 })).toMatch(
      /not authorized/,
    );
  });
});