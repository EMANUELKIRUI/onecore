const supportedLanguages = new Set(["en", "sw"]);
const defaultLocale = "en";
const supportedCurrencies =
  typeof Intl.supportedValuesOf === "function"
    ? new Set(Intl.supportedValuesOf("currency"))
    : new Set();

function canonicalizeSupportedLocale(value) {
  if (typeof value !== "string") return undefined;
  try {
    const locale = Intl.getCanonicalLocales(value)[0];
    if (locale && supportedLanguages.has(new Intl.Locale(locale).language)) {
      return locale;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveLocale(locale, fallbackLocale = defaultLocale) {
  return (
    canonicalizeSupportedLocale(locale) ??
    canonicalizeSupportedLocale(fallbackLocale) ??
    defaultLocale
  );
}

export function translate(
  key,
  { locale, fallbackLocale = defaultLocale, messages = {}, fallbackText } = {},
) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Translation key must be a non-empty string");
  }
  if (typeof fallbackText !== "string") {
    throw new TypeError("A fallback text is required for translation lookup");
  }

  const fallback = resolveLocale(fallbackLocale);
  const requested = canonicalizeSupportedLocale(locale) ?? fallback;
  const candidates = [
    requested,
    requested.split("-")[0],
    fallback,
    fallback.split("-")[0],
  ];
  for (const candidate of new Set(candidates)) {
    const translated = messages[candidate]?.[key];
    if (typeof translated === "string") return translated;
  }
  return fallbackText;
}

function dateFromInstant(value) {
  if (!(value instanceof Date) && typeof value !== "number") {
    throw new TypeError(
      "Date formatting requires a Date or epoch-millisecond value",
    );
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Cannot format an invalid date");
  }
  return date;
}

function formatterLocale(locale) {
  if (typeof locale !== "string") return defaultLocale;
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? defaultLocale;
  } catch {
    return defaultLocale;
  }
}

function dateTimeOptions(options) {
  const formatOptions = { ...options };
  delete formatOptions.locale;
  return {
    timeZone: formatOptions.timeZone ?? "UTC",
    ...formatOptions,
  };
}

export function formatDate(value, options = {}) {
  return new Intl.DateTimeFormat(formatterLocale(options.locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...dateTimeOptions(options),
  }).format(dateFromInstant(value));
}

export function formatTime(value, options = {}) {
  return new Intl.DateTimeFormat(formatterLocale(options.locale), {
    hour: "numeric",
    minute: "2-digit",
    ...dateTimeOptions(options),
  }).format(dateFromInstant(value));
}

export function formatDateTime(value, options = {}) {
  return new Intl.DateTimeFormat(formatterLocale(options.locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...dateTimeOptions(options),
  }).format(dateFromInstant(value));
}

export function formatNumber(value, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Number formatting requires a finite number");
  }
  const { locale, ...numberOptions } = options;
  return new Intl.NumberFormat(formatterLocale(locale), numberOptions).format(
    value,
  );
}

export function formatPercentage(value, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Percentage formatting requires a finite number");
  }
  const { locale, ...numberOptions } = options;
  return new Intl.NumberFormat(formatterLocale(locale), {
    ...numberOptions,
    style: "percent",
  }).format(value);
}

export function formatCurrency(value, currency, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Currency formatting requires a finite number");
  }
  if (
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) ||
    !supportedCurrencies.has(currency)
  ) {
    throw new RangeError("Currency must be supported by the Intl runtime");
  }
  const { locale, ...numberOptions } = options;
  return new Intl.NumberFormat(formatterLocale(locale), {
    ...numberOptions,
    style: "currency",
    currency,
  }).format(value);
}
