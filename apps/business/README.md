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
configuration API. Authorized changes to the legal name, registration/tax
numbers, country, currency, locale, and time zone use that API's existing
`PATCH` contract and `core.organization.settings.update` authorization. The
organization name, lifecycle state, and a typed contact/address profile are
not editable or fully exposed by this contract. Branch choices continue to
come from the authenticated session and switching uses the existing
session-bound branch API.

Customers and Products & Services use the tenant-authorized Business Manager
domain and APIs. The UI reads server-paginated records and sends create,
update, and deactivate operations to the organization-scoped endpoints.
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
quantities, locations, and stock movements. The app does not implement POS,
Inventory, Finance, Sales, or CRM transactions.

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
session. The member view lists only the signed-in user's own
active memberships; no tenant member directory, membership details/role
assignment UI, organization lifecycle editor, or branch management API is
available to this app. Likewise, there is no tenant-authorized audit-log read
API or active-session/device revocation API. These unavailable capabilities
are identified in the UI rather than represented with fake data or CRUD.

Module and capability navigation is filtered by successful protected API
reads as a usability feature; direct URLs and frontend checks do not grant
access. Every API remains responsible for authorization, tenant, branch, and
data-scope enforcement. Message templates display status/version metadata but
not template bodies. Communication delivery views omit message content,
recipient details, credentials, and internal payloads.

No POS, inventory, finance/accounting, HR/payroll, CRM, industry module, AI
screen, or visual workflow designer is included. Workflow UI is limited to the
Phase 18 execution history and safe action status supported by its API.

The app uses native HTML, CSS, and ES modules; no framework, bundler, or
compiled application artifact is required. Serve this directory and
`packages/ui/` from the same static origin, with that origin reverse-proxying
the used API paths to OneCore. Configure the optional `onecore-api-base` meta
tag with a same-origin path prefix only. Frontend authentication state remains
in memory and the HttpOnly cookie is managed by the API.
