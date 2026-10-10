# Business application

## Visual system

The authenticated workspace and public marketing site share the design tokens
and responsive components in `packages/ui/styles.css`. The business shell uses
the organization context returned by the session API, a deep-blue responsive
navigation drawer, and a compact header. Dashboard summaries and quick links
are sourced from existing session, entitlement, and protected API responses;
the UI does not invent sales, inventory, or analytics values. Customer and
catalog search and management continue to use the existing Business Manager
API, with authorization enforced by the server.

## Business Manager

The existing authenticated workspace now groups its supported organization
operations under Business Manager. The overview reuses the verified session,
organization module/entitlement, notification, and workflow APIs; it does not
invent customer counts, sales metrics, or organization lifecycle state.

The Business profile reads organization and business settings from the existing
configuration API. Authorized changes to legal identity, business contact and
address fields, country, currency, locale, and time zone use its existing
`GET/PATCH /organizations/:organizationId/configuration` contract and
`core.organization.settings.read/update` authorization. Contact and address
fields use explicit nullable columns in `business_settings`; application
submissions are backfilled for active organizations by the additive profile
migration. Owner application details are not returned by the business profile
response. Organization name and lifecycle status remain read-only. Branch
choices continue to come from the authenticated session and switching uses
the existing session-bound branch API.
The configuration read response advertises whether the current session has the
settings update permission; read-only users retain profile visibility without
seeing edit forms. The API continues to authorize every update independently.

Customers and Products & Services use the tenant-authorized Business Manager
domain and APIs. The UI reads server-paginated records and sends create,
update, and deactivate operations to the organization-scoped endpoints.
The list responses include advisory per-resource capabilities so read-only
members do not see mutation controls; the API independently authorizes every
request and checks data scope.
Branch selection comes from the authenticated session; changing organization
or branch clears and reloads the view. Workflow activity is available from the
existing Phase 18 execution-history API; a tenant audit-log read API is not
available.

Branch-scoped customer and catalog reads include organization-wide records and
records for the verified current branch, never records for other branches.
Branch-scoped updates and deactivation are limited to current-branch records.

Customer and catalog access requires the `core.business_manager` module
entitlement and the corresponding `core.business_manager.customer.*` or
`core.business_manager.catalog.*` permission. The API remains authoritative
for organization membership, module entitlement, permissions, branch context,
data scopes, and database row-level security. See
[`docs/modules/business-manager.md`](../../docs/modules/business-manager.md)
for resource fields, routes, lifecycle, and security boundaries.

Business Manager owns product/service master data only. Inventory owns
quantities, locations, and stock movements. POS submits unpaid sale requests
through the existing Sales API; it does not add inventory management, Finance,
or CRM transaction features.

## Point of sale

The authenticated Point of sale view combines a catalog-backed draft with
authorized creation of unpaid sales. It reads active products and services from
`GET /organizations/:organizationId/business/catalog` using the existing
organization authorization, module entitlement, branch context, data-scope,
and tenant RLS checks. Search is limited to the catalog API's supported item
name and reference/SKU fields; barcode search and stock availability are not
available.

Users can prepare an in-memory draft cart with positive whole-number
quantities and exact catalog-decimal line and subtotal estimates. Checkout
sends only catalog item IDs and quantities to
`POST /organizations/:organizationId/sales`; the API determines prices,
currency, and totals. A validated `201` response displays the returned sale ID,
status, currency, total, and line amounts as **Unpaid — OPEN**. The cart is
cleared only after that confirmed response.

Before sending, the browser stores the idempotency key, authenticated
user/organization/branch context, and exact request lines in tab-scoped session
storage. An uncertain network result can retry that same request and key; a changed request or
idempotency conflict blocks a new checkout. The API has no lookup by
idempotency key, so ambiguous attempts cannot always be reconciled
automatically and may require an authorized operator to inspect Sales records.
Authentication tokens and prices are not stored with the attempt.

The existing Sales API currently requires `core.inventory.stock.reserve` and
delegates product lines to its inventory reservation service. POS does not
query availability or offer inventory controls, and checkout can be rejected
by the server. The API has no payment action or finalized receipt; the UI does
not create local or simulated sales.

## Existing workspace capabilities

The authenticated workspace provides a data-backed dashboard with verified
organization and branch context, registered module/entitlement status, recent
notifications, and workflow execution status. Authorized screens use existing
APIs for the signed-in user's notification preferences, recipient-scoped
communication delivery status, message-template metadata, organization
configuration, effective feature availability, role permission grants and data
scopes, and workflow execution history. Notification preferences and language
can be updated through the existing self-service preferences API.

Login/session handling, profile/session summary, password change, and sign-out
are included. Regional organization settings and legal name can be updated
through the existing settings API; effective feature values remain read-only.
The branch view lists only active branch choices returned by the authenticated
session. The member directory uses the tenant-authorized
`GET /organizations/:organizationId/members` API and requires the
organization-scoped `core.organization.user.read` permission. It lists member
identity and membership status only. The member roles disclosure reads
`GET /organizations/:organizationId/members/:membershipId/roles` using
`core.rbac.role.read`; assignment and removal use the existing
`POST /auth/membership/roles` and
`DELETE /auth/membership/roles/:membershipId/:roleId` APIs, requiring
`core.rbac.membership_role.assign` and
`core.rbac.membership_role.remove`. The UI is not an authorization boundary:
the API enforces organization scope, protects owner capability and self-role
changes, and audits role mutations. Organization lifecycle editing is not
available. Branch administration is available through the permission-aware
Branches view: it lists paginated organization branches and offers create,
update, and `ACTIVE`/`INACTIVE` actions only when the API returns the matching
capabilities. The API independently enforces `core.organization.branch.read`,
`.create`, and `.update`, organization context, audit behavior, and forced
RLS. Each member row has a branch-access disclosure backed by the membership
branch API. It displays explicit/effective access and offers assignment or
removal only when its capability response permits it; `ALL`-mode access is
read-only. The API remains authoritative for every mutation. Likewise,
there is no tenant-authorized
audit-log read API or active-session/device revocation API. These unavailable
capabilities are identified in the UI rather than represented with fake data
or CRUD.

Module and capability navigation is filtered by successful protected API
reads as a usability feature; direct URLs and frontend checks do not grant
access. Every API remains responsible for authorization, tenant, branch, and
data-scope enforcement. Message templates display status/version metadata but
not template bodies. Communication delivery views omit message content,
recipient details, credentials, and internal payloads.

No POS checkout, inventory, finance/accounting, HR/payroll, CRM, industry
module, AI screen, or visual workflow designer is included. Workflow UI is
limited to the Phase 18 execution history and safe action status supported by
its API.

The app uses native HTML, CSS, and ES modules; no framework, bundler, or
compiled application artifact is required. Serve this directory and
`packages/ui/` from the same static origin, with that origin reverse-proxying
the used API paths to OneCore. Configure the optional `onecore-api-base` meta
tag with a same-origin path prefix only. Frontend authentication state remains
in memory and the HttpOnly cookie is managed by the API.
