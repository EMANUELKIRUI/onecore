# Business Manager frontend capability map

## Status

**IMPLEMENTED FOUNDATION.** Business Manager provides tenant-authorized
customer and product/service master-data APIs and authenticated CRUD screens.
It is not POS, Sales, Inventory, Finance, or CRM.

## Resource map

### Overview — IMPLEMENTED

- **Support:** Verified organization membership, module
  registry/entitlements, notifications, and workflow execution data exist. No
  sales/customer/product metrics exist.
- **API/authorization:** `GET /auth/session`; `GET /modules`
  (`core.modules.module.read`); `GET /organizations/:organizationId/modules`
  (`core.modules.entitlement.read`). Notification and workflow-history reads
  keep their existing permissions and server scopes.
- **UI:** Data-backed overview, with no fabricated metrics.

### Business profile — PARTIALLY IMPLEMENTED

- **Support:** `organizations`, `organization_settings`, and
  `business_settings` tables persist organization name, industry, deployment
  type, legal name, registration/tax numbers, regional settings, and typed
  business contact/address fields. Owner/application details remain in the
  organization application profile.
- **API/authorization:** `GET /organizations/:organizationId/configuration`
  uses `core.organization.settings.read`; `PATCH` uses
  `core.organization.settings.update`. The business profile projection returns
  contact email/phone, website, country, region, city, and address without
  returning owner details. The server binds organization context.
- **UI:** Displays profile/business/regional fields and updates legal
  identity, contact/address, country, currency, locale, and time zone.
  Lifecycle/name mutation and arbitrary JSON rendering are not supported.

### Branch administration — IMPLEMENTED — VERIFICATION PENDING

- **Support:** Branch and membership-branch tables exist with tenant-composite
  keys and forced RLS. Session identity resolves active branches available to
  the current membership.
- **API/authorization:** Branch listing, creation, and update use
  `core.organization.branch.read/create/update` at organization scope.
  Membership branch listing, assignment, and removal use separate
  `core.organization.membership_branch.read/assign/remove` permissions. The
  assignment API rejects inactive or cross-tenant branches, self-targeting,
  and explicit mutations against `ALL` memberships.
- **UI:** The existing Business app provides paginated branch administration,
  create/update forms, active/inactive status changes, and permission-aware
  navigation. Membership branch assignment has no UI.
- **Verification:** API tests cover route authorization, denial auditing,
  branch-code validation, assignment idempotency, tenant/lifecycle checks,
  and RLS. The assignment and repair migrations succeed as non-bypass
  `onecore_migrator` on PostgreSQL 18.6 with existing Owner/Admin fixtures.
  Replay of the earlier branch-admin permission backfill with existing roles
  fails the forced-RLS check, and the ordered migration runner cannot reach
  the later repair while that predecessor remains unapplied. The deployment
  migration history must be reconciled, and membership assignment has no UI;
  the feature is not complete.

### Customers — IMPLEMENTED

- **Purpose:** Organization customer/contact master data for future business
  modules; no CRM pipeline, leads, campaigns, scoring, or loyalty.
- **Storage:** `customers` stores organization ownership, optional branch
  applicability, reference, name, bounded type (`INDIVIDUAL` or `BUSINESS`),
  phone, email, bounded status (`ACTIVE`/`INACTIVE`), notes, creator, and
  timestamps. References are case-insensitively unique within an organization.
- **API:** `GET/POST /organizations/:organizationId/business/customers`,
  `GET/PATCH/DELETE /organizations/:organizationId/business/customers/:id`.
  Lists accept bounded `search`, `status`, `branchId`, `limit`, and `offset`.
  Search covers name, reference, email, and phone.
- **Permissions:** `core.business_manager.customer.read/create/update/delete`.
  `core.business_manager` must be available, enabled, plan-eligible, and have
  satisfied dependencies. Existing authorization resolves active
  organization membership, role permission, and data scope server-side.
- **Branch/security:** Rows may be organization-wide (`branchId = null`) or
  branch-applicable. New branch-specific rows use the verified active branch;
  clients cannot select a different branch. Read/update/deactivate queries
  constrain organization and effective organization/branch/owner data scopes.
  Branch-scoped reads include organization-wide rows and the selected branch's
  rows, but not other branches; the current-branch filter follows the same
  rule. Branch-scoped updates and deactivation are limited to the selected
  branch's rows. PostgreSQL RLS is enabled and forced with tenant context
  required for all reads and writes.
- **Lifecycle/events:** `DELETE` deactivates the record (`INACTIVE`) to retain
  stable IDs for future references. Mutations write audit entries and
  transactional `CUSTOMER_CREATED`, `CUSTOMER_UPDATED`, or
  `CUSTOMER_DELETED` outbox events. These event types are not in the Phase 18
  workflow-trigger allowlist.
- **UI:** API-backed search/filter, pagination, detail, create, edit, and
  confirmation-based deactivate flows. API authorization, validation, conflict
  and transient failures remain visible; no browser-stored business records.

### Products & services — IMPLEMENTED

- **Purpose:** Reusable organization product/service master data. A catalog
  item has a bounded type (`PRODUCT`/`SERVICE`), reference/SKU, name,
  description, unit, non-negative fixed-precision decimal price, ISO currency,
  status, optional branch applicability, creator, and timestamps.
- **Storage/API:** The tenant-owned `catalog_items` table uses
  `GET/POST /organizations/:organizationId/business/catalog` and
  `GET/PATCH/DELETE /organizations/:organizationId/business/catalog/:id`.
  Lists accept bounded `search`, `type`, `status`, `branchId`, `limit`, and
  `offset`; search covers name and reference. References are case-insensitively
  unique per organization.
- **Permissions/security:** `core.business_manager.catalog.read/create/update/delete`.
  The same module-entitlement, organization, branch, permission, effective
  data-scope, and forced tenant-RLS rules as customers apply. Currency is
  validated through the shared regionalization currency schema; prices remain
  decimal strings and use PostgreSQL `numeric`, not binary floating point.
- **Lifecycle/events:** `DELETE` changes status to `INACTIVE`, retaining IDs.
  Mutations are audited and emit `CATALOG_ITEM_CREATED`,
  `CATALOG_ITEM_UPDATED`, or `CATALOG_ITEM_DELETED` outbox events; these are
  not workflow triggers.
- **UI:** API-backed search, type/status and authorized branch filters,
  pagination, detail, create/edit, and confirmed deactivation.

> Business Manager owns product/service master data. Inventory owns quantities
> and stock movements.

Future consumers can reference stable IDs:

```text
Customer
   ↓
Sales/POS

Catalog
   ├── POS/Sales
   ├── Inventory
   └── Purchases
```

These future modules and transaction flows are not implemented here.

### Module availability — IMPLEMENTED

- **Support/API:** Module manifests, registry, and organization entitlements
  are read from existing APIs using canonical module/entitlement read
  permissions. `core.business_manager` is a registered, available module and
  its resource permissions are linked through the standard module permission
  catalog.
- **UI:** Resource navigation is exposed only after the server-authorized
  list endpoint succeeds. Direct requests remain server-authorized.

### Workflow activity — IMPLEMENTED

- **Support/API:** Phase 18 execution/action persistence and bounded runtime
  expose `GET /organizations/:organizationId/workflow-executions`, guarded by
  `core.organization.workflows.read`, the `core.configuration` entitlement,
  tenant context, and data scope.
- **UI:** Workflow execution activity only, not a complete audit feed.

### Audit/activity log — BACKEND BLOCKED

- **Support:** Audit records are written by existing server mechanisms.
- **API:** No tenant-authorized audit-log read route is exposed to this app.
- **UI:** No inference from unrelated resources.

### Business settings — PARTIALLY IMPLEMENTED

- **Support/API:** Existing configuration `GET/PATCH` routes use settings
  read/update permissions. Updates produce existing configuration events and
  audit records. Opaque address/tax JSON has no stable nested UI contract.
- **UI:** Supported scalar fields only; unknown JSON fields and secrets are
  not displayed.

## Future module integration

Business Manager does not own stock quantities, warehouse locations, stock
movements, purchases, sales transactions, payments, accounting entries, or
analytics. Future modules should reference customer/catalog IDs rather than
duplicate master data, register through the existing module and entitlement
system, and define their own transaction and security contracts. The backend
remains authoritative for every direct URL and mutation.
