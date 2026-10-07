# ADR 0013: Shared localization and regionalization foundation

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Organization settings already persist country code, currency code, timezone,
and locale, with tenant-authorized APIs and existing RLS boundaries. Locale
validation was only length-based, currency validation checked only its shape,
and the UI had no shared translation fallback or locale-aware formatting
utilities. OneCore requires a reusable regionalization foundation without
embedding country-specific business rules or adding a frontend framework.

## Decision

- Keep the existing organization settings record, API, authorization, tenant
  transaction, and database policies as the source of truth; add no tables or
  persistence changes.
- Validate and canonicalize BCP 47 locale tags through shared core-domain
  schemas. The initial accepted language set remains English and Kiswahili,
  with regional tags allowed for those languages.
- Validate currency identifiers against the runtime's native `Intl` currency
  data, validate country values as uppercase alpha-2 codes, and validate
  timezones using native IANA timezone support.
- Provide dependency-free UI translation lookup with explicit caller-supplied
  catalogs and fallback text, plus native `Intl` presentation formatters.
- Treat formatted dates/times as presentation of instants. Require callers to
  supply a timezone where business-local presentation is needed; default to
  UTC rather than an implicit host timezone. Keep API and persisted values
  structured and machine-readable.

## Consequences and boundaries

- This adds no product translation catalog, locale selector, personal
  preference storage, country registry, or country-specific calendar.
- `Intl` locale formatting can use valid presentation locales beyond the
  product's currently accepted organization-language set; this does not enable
  translated UI content for those languages.
- Currency precision follows native `Intl` currency conventions only for
  display. No tax, accounting, exchange-rate, payroll, statutory, or legal
  calculation is introduced.
- Future country-specific behavior belongs in the relevant domain/module and
  its configuration, not the shared regionalization helpers.
- Existing tenant isolation, RLS, RBAC, audit/event behavior, and server-side
  authority remain unchanged.
