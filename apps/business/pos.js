const CATALOG_PRICE_SCALE = 1_000_000n;
const CHECKOUT_STORAGE_KEY = "onecore.sales.pending-checkout";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const SALE_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,6})?$/;
const UNIT_PRICE_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const MAX_DRAFT_QUANTITY = 1_000_000;

export function catalogPriceToScaledAmount(price) {
  if (
    typeof price !== "string" ||
    !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(price)
  ) {
    throw new RangeError("Catalog price must be a non-negative decimal.");
  }
  const [whole, fraction = ""] = price.split(".");
  return BigInt(whole) * CATALOG_PRICE_SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function formatScaledAmount(amount) {
  if (typeof amount !== "bigint" || amount < 0n) {
    throw new RangeError("Amount must be a non-negative integer.");
  }
  const whole = amount / CATALOG_PRICE_SCALE;
  const fraction = (amount % CATALOG_PRICE_SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function parseDraftQuantity(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity <= MAX_DRAFT_QUANTITY
    ? quantity
    : null;
}

export function addDraftCartItem(cart, item) {
  if (!(cart instanceof Map)) {
    throw new TypeError("Draft cart must be a Map.");
  }
  if (
    !item ||
    item.status !== "ACTIVE" ||
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.unit !== "string" ||
    typeof item.currency !== "string" ||
    !/^[A-Z]{3}$/.test(item.currency)
  ) {
    throw new TypeError("Only valid active catalog items can be added.");
  }
  catalogPriceToScaledAmount(item.price);

  const currentCurrency = cart.values().next().value?.currency;
  if (currentCurrency && currentCurrency !== item.currency) return false;

  const currentQuantity = cart.get(item.id)?.quantity ?? 0;
  if (!cart.has(item.id) && cart.size >= 100) return false;
  if (
    !Number.isSafeInteger(currentQuantity + 1) ||
    currentQuantity >= MAX_DRAFT_QUANTITY
  )
    return false;
  cart.set(item.id, {
    id: item.id,
    name: item.name,
    reference: item.reference ?? null,
    type: item.type,
    unit: item.unit,
    price: item.price,
    currency: item.currency,
    quantity: currentQuantity + 1,
  });
  return true;
}

export function setDraftCartQuantity(cart, itemId, value) {
  const quantity = parseDraftQuantity(value);
  const item = cart.get(itemId);
  if (!item || quantity === null) return false;
  cart.set(itemId, { ...item, quantity });
  return true;
}

export function removeDraftCartItem(cart, itemId) {
  return cart.delete(itemId);
}

export function draftCartSubtotal(cart) {
  let currency;
  let amount = 0n;
  for (const item of cart.values()) {
    if (currency && currency !== item.currency) {
      throw new RangeError("Draft cart items must use one currency.");
    }
    currency = item.currency;
    amount += catalogPriceToScaledAmount(item.price) * BigInt(item.quantity);
  }
  return currency ? { currency, amount } : null;
}

export function saleCheckoutRequestFromCart(cart) {
  if (!(cart instanceof Map) || cart.size < 1 || cart.size > 100) {
    throw new RangeError("A checkout must contain between 1 and 100 items.");
  }
  return {
    lines: [...cart.values()].map(({ id, quantity }) => {
      if (
        typeof id !== "string" ||
        !UUID_PATTERN.test(id) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > MAX_DRAFT_QUANTITY
      ) {
        throw new RangeError(
          "Checkout items require valid IDs and quantities.",
        );
      }
      return { catalogItemId: id, quantity };
    }),
  };
}

function isCheckoutRequest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.lines) &&
    value.lines.length > 0 &&
    value.lines.length <= 100 &&
    value.lines.every(
      (line, index) =>
        line !== null &&
        typeof line === "object" &&
        UUID_PATTERN.test(line.catalogItemId) &&
        Number.isSafeInteger(line.quantity) &&
        line.quantity > 0 &&
        line.quantity <= MAX_DRAFT_QUANTITY &&
        value.lines.findIndex(
          (candidate) => candidate.catalogItemId === line.catalogItemId,
        ) === index,
    )
  );
}

function isStoredAttempt(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    IDEMPOTENCY_KEY_PATTERN.test(value.key) &&
    UUID_PATTERN.test(value.organizationId) &&
    UUID_PATTERN.test(value.userId) &&
    (value.branchId === null || UUID_PATTERN.test(value.branchId)) &&
    ["PENDING", "UNCERTAIN", "CONFLICT"].includes(value.status) &&
    isCheckoutRequest(value.request)
  );
}

function sameRequest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameContext(attempt, context) {
  return (
    attempt.organizationId === context.organizationId &&
    attempt.userId === context.userId &&
    attempt.branchId === context.branchId
  );
}

function saleAmountToScaled(value) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * CATALOG_PRICE_SCALE + BigInt(fraction.padEnd(6, "0"));
}

function isSaleResponse(response, attempt) {
  const sale = response?.sale;
  const validShape =
    response !== null &&
    typeof response === "object" &&
    sale !== null &&
    typeof sale === "object" &&
    UUID_PATTERN.test(sale.id) &&
    sale.organizationId === attempt.organizationId &&
    sale.branchId === attempt.branchId &&
    sale.status === "OPEN" &&
    typeof sale.currency === "string" &&
    /^[A-Z]{3}$/.test(sale.currency) &&
    typeof sale.subtotal === "string" &&
    SALE_AMOUNT_PATTERN.test(sale.subtotal) &&
    typeof sale.total === "string" &&
    SALE_AMOUNT_PATTERN.test(sale.total) &&
    sale.total === sale.subtotal &&
    Array.isArray(sale.lines) &&
    sale.lines.length === attempt.request.lines.length;
  if (!validShape) return false;

  let lineTotalSum = 0n;
  for (const [index, line] of sale.lines.entries()) {
    const requestedLine = attempt.request.lines[index];
    if (
      line === null ||
      typeof line !== "object" ||
      line.catalogItemId !== requestedLine.catalogItemId ||
      line.quantity !== requestedLine.quantity ||
      typeof line.itemName !== "string" ||
      typeof line.unitPrice !== "string" ||
      !UNIT_PRICE_PATTERN.test(line.unitPrice) ||
      typeof line.lineTotal !== "string" ||
      !SALE_AMOUNT_PATTERN.test(line.lineTotal)
    ) {
      return false;
    }
    const lineTotal = saleAmountToScaled(line.lineTotal);
    if (
      saleAmountToScaled(line.unitPrice) * BigInt(line.quantity) !==
      lineTotal
    ) {
      return false;
    }
    lineTotalSum += lineTotal;
  }
  return lineTotalSum === saleAmountToScaled(sale.subtotal);
}

export function createSaleCheckoutController({
  storage,
  request,
  createKey = () => globalThis.crypto.randomUUID(),
  timeoutMs = 20_000,
}) {
  let inFlight = false;

  function readAttempt() {
    if (!storage) return { kind: "STORAGE_ERROR" };
    let stored;
    try {
      stored = storage.getItem(CHECKOUT_STORAGE_KEY);
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
      storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(attempt));
      return true;
    } catch {
      return false;
    }
  }

  function updateAttempt(attempt, status) {
    storeAttempt({ ...attempt, status });
  }

  function removeAttempt() {
    try {
      storage.removeItem(CHECKOUT_STORAGE_KEY);
    } catch {
      return;
    }
  }

  function getState(context) {
    const current = readAttempt();
    if (current.kind === "NONE" || current.kind === "STORAGE_ERROR") {
      return current;
    }
    if (current.kind === "INVALID") return current;
    if (!sameContext(current.attempt, context)) {
      return { kind: "OTHER_CONTEXT", attempt: current.attempt };
    }
    return current;
  }

  async function submit(cart, context) {
    if (inFlight) return { kind: "IN_PROGRESS" };
    if (
      !context ||
      !UUID_PATTERN.test(context.organizationId) ||
      !UUID_PATTERN.test(context.userId)
    ) {
      return { kind: "INVALID_CONTEXT" };
    }

    const current = readAttempt();
    if (current.kind === "STORAGE_ERROR" || current.kind === "INVALID") {
      return current;
    }

    let attempt;
    if (current.kind !== "NONE") {
      attempt = current.attempt;
      if (!sameContext(attempt, context)) {
        return { kind: "OTHER_CONTEXT", attempt };
      }
      if (current.kind === "CONFLICT") return { kind: "CONFLICT", attempt };
      if (cart.size > 0) {
        let currentRequest;
        try {
          currentRequest = saleCheckoutRequestFromCart(cart);
        } catch {
          return { kind: "MISMATCH", attempt };
        }
        if (!sameRequest(currentRequest, attempt.request)) {
          return { kind: "MISMATCH", attempt };
        }
      }
    } else {
      let checkoutRequest;
      try {
        checkoutRequest = saleCheckoutRequestFromCart(cart);
      } catch {
        return { kind: "EMPTY_OR_INVALID_CART" };
      }
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
        branchId: context.branchId ?? null,
        request: checkoutRequest,
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
        `/organizations/${encodeURIComponent(attempt.organizationId)}/sales`,
        {
          method: "POST",
          headers: { "Idempotency-Key": attempt.key },
          body: attempt.request,
          expectedStatus: 201,
          signal: abortController.signal,
        },
      );
      if (!isSaleResponse(response, attempt)) {
        updateAttempt(attempt, "UNCERTAIN");
        return { kind: "UNCERTAIN", reason: "INVALID_RESPONSE" };
      }
      removeAttempt();
      return { kind: "SUCCESS", sale: response.sale };
    } catch (error) {
      const status = error?.status;
      const code = error?.code;
      if (status === 409 && code === "CONFLICT") {
        updateAttempt(attempt, "CONFLICT");
        return { kind: "CONFLICT", attempt };
      }
      if (status === 409 && code === "INSUFFICIENT_STOCK") {
        removeAttempt();
        return { kind: "REJECTED", status, code };
      }
      if ([400, 401, 403, 404].includes(status)) {
        removeAttempt();
        return { kind: "REJECTED", status, code };
      }
      updateAttempt(attempt, "UNCERTAIN");
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

export function saleCheckoutMessage(result) {
  switch (result.kind) {
    case "IN_PROGRESS":
      return "Checkout is already being submitted.";
    case "OTHER_CONTEXT":
      return "A checkout attempt for another signed-in user, organization, or branch needs reconciliation first.";
    case "MISMATCH":
      return "The cart differs from the pending checkout. Retry the original attempt before changing it.";
    case "CONFLICT":
      return "The server reports this key was used for a different request. Reconcile this attempt before starting another checkout.";
    case "INVALID":
      return "A saved checkout attempt could not be validated. Do not start another checkout in this tab.";
    case "STORAGE_ERROR":
      return "This browser could not safely save the checkout attempt, so no request was sent.";
    case "INVALID_CONTEXT":
      return "Select an authorized organization and active branch before checkout.";
    case "EMPTY_OR_INVALID_CART":
      return "Add valid catalog items before checkout.";
    case "REJECTED":
      if (result.status === 401)
        return "Your session expired. Sign in again; no sale was confirmed.";
      if (result.status === 403)
        return "You are not authorized to create a sale for this organization and branch.";
      if (result.status === 409)
        return "The server could not create this sale. Refresh the catalog before trying again.";
      return "The server could not accept this cart. Review it and try again.";
    case "UNCERTAIN":
      return result.reason === "INVALID_RESPONSE"
        ? "The service returned an unexpected response. The checkout result is uncertain; retry this same attempt."
        : result.reason === "TIMEOUT"
          ? "The request timed out before the sale could be confirmed. Retry this same attempt."
          : "The sale could not be confirmed because of a connection or server error. Retry this same attempt.";
    default:
      return "The checkout could not be completed.";
  }
}
