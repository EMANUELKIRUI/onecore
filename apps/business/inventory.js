const INVENTORY_ATTEMPT_STORAGE_KEY = "onecore.inventory.pending-movement";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const MAX_MOVEMENT_DELTA = 1_000_000;

function normalizeMovement(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    !UUID_PATTERN.test(input.catalogItemId) ||
    !["RECEIPT", "ADJUSTMENT"].includes(input.movementType) ||
    !Number.isSafeInteger(input.delta) ||
    input.delta === 0 ||
    Math.abs(input.delta) > MAX_MOVEMENT_DELTA ||
    (input.movementType === "RECEIPT" && input.delta < 1)
  ) {
    return null;
  }
  return {
    catalogItemId: input.catalogItemId,
    movementType: input.movementType,
    delta: input.delta,
  };
}

function isContext(context) {
  return (
    context !== null &&
    typeof context === "object" &&
    UUID_PATTERN.test(context.organizationId) &&
    UUID_PATTERN.test(context.userId) &&
    UUID_PATTERN.test(context.branchId)
  );
}

function isStoredAttempt(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    IDEMPOTENCY_KEY_PATTERN.test(value.key) &&
    UUID_PATTERN.test(value.organizationId) &&
    UUID_PATTERN.test(value.userId) &&
    UUID_PATTERN.test(value.branchId) &&
    ["PENDING", "UNCERTAIN", "CONFLICT"].includes(value.status) &&
    normalizeMovement(value.request) !== null
  );
}

function sameContext(attempt, context) {
  return (
    attempt.organizationId === context.organizationId &&
    attempt.userId === context.userId &&
    attempt.branchId === context.branchId
  );
}

function sameMovement(left, right) {
  return (
    left.catalogItemId === right.catalogItemId &&
    left.movementType === right.movementType &&
    left.delta === right.delta
  );
}

function isMovementResponse(value, attempt) {
  const stock = value?.stock;
  return (
    value !== null &&
    typeof value === "object" &&
    UUID_PATTERN.test(value.movementId) &&
    stock !== null &&
    typeof stock === "object" &&
    stock.catalogItemId === attempt.request.catalogItemId &&
    stock.itemType === "PRODUCT" &&
    stock.tracked === true &&
    Number.isSafeInteger(stock.onHand) &&
    Number.isSafeInteger(stock.reserved) &&
    Number.isSafeInteger(stock.available) &&
    stock.onHand >= 0 &&
    stock.reserved >= 0 &&
    stock.available === stock.onHand - stock.reserved
  );
}

export function createInventoryMovementController({
  storage,
  request,
  createKey = () => globalThis.crypto.randomUUID(),
  timeoutMs = 20_000,
}) {
  let inFlight = false;

  function readAttempt() {
    if (!storage) return { kind: "STORAGE_ERROR" };
    try {
      const stored = storage.getItem(INVENTORY_ATTEMPT_STORAGE_KEY);
      if (stored === null) return { kind: "NONE" };
      const parsed = JSON.parse(stored);
      return isStoredAttempt(parsed)
        ? { kind: parsed.status, attempt: parsed }
        : { kind: "INVALID" };
    } catch {
      return { kind: "STORAGE_ERROR" };
    }
  }

  function storeAttempt(attempt) {
    try {
      storage.setItem(INVENTORY_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
      return true;
    } catch {
      return false;
    }
  }

  function removeAttempt() {
    try {
      storage.removeItem(INVENTORY_ATTEMPT_STORAGE_KEY);
    } catch {
      return;
    }
  }

  function getState(context) {
    const current = readAttempt();
    if (["NONE", "INVALID", "STORAGE_ERROR"].includes(current.kind)) {
      return current;
    }
    if (!isContext(context) || !sameContext(current.attempt, context)) {
      return { kind: "OTHER_CONTEXT", attempt: current.attempt };
    }
    return current;
  }

  async function submit(input, context) {
    if (inFlight) return { kind: "IN_PROGRESS" };
    if (!isContext(context)) return { kind: "INVALID_CONTEXT" };
    const movement = normalizeMovement(input);
    if (!movement) return { kind: "INVALID_MOVEMENT" };

    const current = readAttempt();
    if (["STORAGE_ERROR", "INVALID"].includes(current.kind)) return current;

    let attempt;
    if (current.kind !== "NONE") {
      attempt = current.attempt;
      if (!sameContext(attempt, context)) {
        return { kind: "OTHER_CONTEXT", attempt };
      }
      if (current.kind === "CONFLICT") return { kind: "CONFLICT", attempt };
      if (!sameMovement(movement, attempt.request)) {
        return { kind: "MISMATCH", attempt };
      }
    } else {
      let key;
      try {
        key = createKey();
      } catch {
        return { kind: "STORAGE_ERROR" };
      }
      if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
        return { kind: "STORAGE_ERROR" };
      }
      attempt = {
        key,
        organizationId: context.organizationId,
        userId: context.userId,
        branchId: context.branchId,
        request: movement,
        status: "PENDING",
      };
      if (!storeAttempt(attempt)) return { kind: "STORAGE_ERROR" };
    }

    inFlight = true;
    const abortController = new globalThis.AbortController();
    const timeout = globalThis.setTimeout(
      () => abortController.abort(),
      timeoutMs,
    );
    try {
      const response = await request(
        `/organizations/${encodeURIComponent(attempt.organizationId)}/inventory/stock`,
        {
          method: "POST",
          headers: { "Idempotency-Key": attempt.key },
          body: attempt.request,
          signal: abortController.signal,
        },
      );
      if (!isMovementResponse(response, attempt)) {
        storeAttempt({ ...attempt, status: "UNCERTAIN" });
        return { kind: "UNCERTAIN", reason: "INVALID_RESPONSE" };
      }
      removeAttempt();
      return { kind: "SUCCESS", movementId: response.movementId, stock: response.stock };
    } catch (error) {
      const status = error?.status;
      const code = error?.code;
      if (status === 409 && code === "CONFLICT") {
        storeAttempt({ ...attempt, status: "CONFLICT" });
        return { kind: "CONFLICT", attempt };
      }
      if ([400, 401, 403, 404, 409].includes(status)) {
        removeAttempt();
        return { kind: "REJECTED", status, code };
      }
      storeAttempt({ ...attempt, status: "UNCERTAIN" });
      return {
        kind: "UNCERTAIN",
        reason: error?.name === "AbortError" ? "TIMEOUT" : "REQUEST_FAILED",
      };
    } finally {
      globalThis.clearTimeout(timeout);
      inFlight = false;
    }
  }

  return { getState, submit };
}

export function inventoryMovementMessage(result) {
  switch (result.kind) {
    case "IN_PROGRESS":
      return "This stock movement is already being submitted.";
    case "OTHER_CONTEXT":
      return "A pending stock movement belongs to another signed-in user, organization, or branch. Return to that context before continuing.";
    case "MISMATCH":
      return "The movement differs from the pending attempt. Retry the original movement before changing its product or quantity.";
    case "CONFLICT":
      return "The server reports this idempotency key was used for a different movement. Reconcile this attempt before starting another.";
    case "INVALID":
      return "A saved movement attempt could not be validated. Do not start another movement in this tab.";
    case "STORAGE_ERROR":
      return "This browser could not safely save the stock movement attempt, so no request was sent.";
    case "INVALID_CONTEXT":
      return "Select an authorized organization and active branch before changing stock.";
    case "INVALID_MOVEMENT":
      return "Choose a product and enter a non-zero whole-number stock change. Receipts must add stock.";
    case "REJECTED":
      if (result.status === 401) return "Your session expired. Sign in again before recording stock.";
      if (result.status === 403) return "You are not authorized to adjust stock for this organization and branch.";
      if (result.status === 409) return "The stock change conflicts with existing reservations or an earlier movement.";
      return "The server could not accept this stock movement. Review the product and quantity.";
    case "UNCERTAIN":
      return "The movement could not be confirmed. Retry this same movement with its saved idempotency key.";
    default:
      return "The stock movement could not be completed.";
  }
}