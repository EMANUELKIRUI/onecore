# Sales transaction foundation

## Status

**IMPLEMENTED — API, DATABASE, AND DISPOSABLE BROWSER/API JOURNEY VERIFIED LOCALLY; TARGET MIGRATION AND DEPLOYMENT VERIFICATION PENDING.**

This is a limited sales-recording and stock-reservation foundation, not a
complete payment, accounting, or receipt system. The Business POS calls these
endpoints. The local Playwright journey verified checkout and an uncertain
request retry against the real API and disposable PostgreSQL; it does not verify
a deployed frontend, API, or database.

## Domain and lifecycle

A sale has a UUID identifier, organization and required branch, creator/cashier
from the authenticated session, a single currency, exact decimal subtotal and
total, creation timestamp, and immutable catalog-line snapshots. A sale line
retains the catalog item identifier, item name, description, SKU/reference,
unit, server-read unit price, positive whole quantity, and calculated line
total. The UUID is the business identifier; no sale-numbering policy is
defined.

The only supported state is `OPEN`. It means the record was created and is
unpaid; there are no lifecycle transitions, payment confirmation, cancellation,
refund, or finalized receipt operations. Sale headers and lines cannot be
updated or deleted through the runtime role, and database triggers reject
mutations. `subtotal` and `total` are equal because tax and discount policy is
not defined. Currency is taken from catalog records; mixed-currency lines are
rejected.

## API contract

All operations require a live authenticated session, active organization
membership and organization, a verified active branch assignment, the
`core.sales` module entitlement, and the matching permission:

- `POST /organizations/:organizationId/sales` requires
  `core.sales.sale.create` and an `Idempotency-Key` header. Body:
  `{"lines":[{"catalogItemId":"<uuid>","quantity":1}]}`. It accepts 1-100
  unique active catalog item IDs and quantities from 1 to 1,000,000. The
  server resolves organization, branch, cashier, item description/reference,
  price, and currency; client-submitted totals, prices, discounts, taxes,
  stock quantities, and identity/scope fields are rejected.
- `GET /organizations/:organizationId/sales?limit=50&offset=0` requires
  `core.sales.sale.read` and returns a bounded, current-branch page of sale
  summaries. Effective permission data scope is additionally applied.
- `GET /organizations/:organizationId/sales/:saleId` requires the same read
  permission and returns historical line snapshots only within the authorized
  current branch and data scope.

The create response is `201 { "sale": { id, organizationId, branchId,
status, currency, subtotal, total, createdByUserId, createdAt, lines } }`.
List responses contain summary items plus `total`, `limit`, and `offset`.
Amounts are decimal strings, never binary floating-point values.
Domain total calculation raises `RangeError` with the message
`Sale amount must fit PostgreSQL numeric(26,6) precision.` if a line or subtotal
cannot be represented; valid current request limits are also bounded below the
column maximum.

Idempotency keys are printable ASCII, 1-200 characters, unique per
organization and this checkout operation. A retry with the same authenticated
creator, key, branch, and semantic item/quantity set returns the original sale and original `201`
outcome, even if catalog prices later change. Reordering lines is treated as
the same semantic request. Reusing a key with a changed payload or branch
returns a generic `409 CONFLICT`. Clients recovering from an uncertain timeout
must retry with the original key, not create a new one.

Validation failures return `400`; missing authentication returns `401`,
authorization/branch failure returns `403`, foreign-tenant resources are
concealed as `404`, and idempotency conflicts return `409`. Internal errors
remain generic and do not expose stack traces.

## Persistence and security

The forward-only migration
`20261010184156_sales_checkout_foundation` creates `sales` and `sale_lines`,
organization/branch-composite foreign keys, a per-organization idempotency
unique index, immutable numeric snapshots, forced RLS, and narrow runtime
grants. It registers `core.sales` and create/read permission catalog entries.
It does not add plan eligibility, organization entitlements, or role grants;
Sales is denied until a trusted product/entitlement decision and authorized
RBAC grants enable it. Permission names from legacy `sales.*` entries are not
used as authorization claims.

The API invokes the central authorization service; that service verifies the
live session, membership, organization, active branch and entitlement inside
the tenant transaction. Tenant RLS and same-organization composite foreign
keys remain independent database boundaries. Catalog rows are read under
shared locks and validated for active status, tenant, branch applicability,
and common currency before snapshots and exact totals are persisted.

The sale, lines, product stock reservations and reservation movements,
`SALE_CREATED` outbox event, and audit records commit in one transaction.
Same-key concurrent requests converge on the unique idempotency record; an
insufficient-stock, line, reservation, or outbox failure rolls the transaction
back. The event contains only sale ID and line count. It does not signal
payment or finalization.

## Unsupported behavior

The inventory foundation tracks branch stock balances, receipt/adjustment
movements, and product reservations created by sales. Reservations reduce
available stock and insufficient availability rejects checkout. This is not a
full Inventory module: purchasing, suppliers, valuation/costing,
replenishment, and broader stock workflows are not implemented.

No payment provider is integrated; the API accepts no card data and never
marks a sale paid. Tax, discount, accounting, receipt numbering, payment,
refund, reconciliation, and offline policies require explicit decisions and
future implementation. The only supported sale state is `OPEN` (unpaid); a
receipt endpoint is unavailable.

The generated migration has been replayed by disposable PGlite tests only. No
external migration ledger, production database, or deployment was inspected
or changed. The documented branch-administration migration-order blocker must
be reconciled by the migration owner before applying later migrations to any
target environment.
