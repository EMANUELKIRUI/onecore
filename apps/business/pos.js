const CATALOG_PRICE_SCALE = 1_000_000n;

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
  return Number.isSafeInteger(quantity) 
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
  if (!Number.isSafeInteger(currentQuantity + 1)) return false;
  cart.set(item.id, {
     naeference: item.reference ?? null,  price: item.p currency: item.currency,
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
