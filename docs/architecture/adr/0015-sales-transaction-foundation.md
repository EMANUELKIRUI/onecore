# ADR 0015: Limited Sales Transaction Foundation

## Status

Accepted for the initial sales-recording slice. Business policy and deployment
verification remain pending.

## Context

OneCore has tenant-authorized product/service catalog master data, PostgreSQL
transactions, centralized authorization, forced RLS, and a transactional
outbox. It does not have authoritative inventory, a payment-provider
abstraction, tax/discount rules, accounting, or receipt-numbering policy.
Representing checkout as paid or stock-controlled would therefore make
unsupported claims.

## Decision

- Record only an immutable `OPEN` sale from server-read active catalog items.
  `OPEN` is unpaid. No mutation, payment, cancellation, refund, or finalized
  receipt transition is exposed.
- Calculate line totals and sale totals on the server using exact integer
  scaling for catalog numeric values. Until business rules exist, total equals
  subtotal and mixed currencies, taxes, and discounts are unsupported.
- Require a verified active branch and persist transaction-time catalog
  snapshots. The sale UUID is the identifier; sale-number policy is deferred.
- Scope idempotency to organization and the sales-create operation, store a
  canonical payload hash with the sale, and rely on a database unique
  constraint for concurrent duplicate protection.
- Commit sale, lines, audit, and `SALE_CREATED` outbox event together. Do not
  emit finalized/payment events.
- Add the `core.sales` module and create/read permission catalog but do not
  add plan eligibility, organization entitlements, or default role grants.
  Sales remains denied until product policy and trusted activation are
  explicitly approved.
- Do not create placeholder inventory, payment, tax, discount, or receipt
  abstractions. Keep POS frontend integration deferred until its request,
  retry, and uncertain-timeout behavior is wired to this API.

## Consequences

The backend can persist and retrieve tenant/branch-scoped sale records with
historical prices and retry safety. It cannot guarantee stock availability,
payment, tax correctness, discount correctness, accounting treatment, or a
receipt. Migration files and disposable test success do not mean a target
database has applied the migration or that deployment is production-ready.