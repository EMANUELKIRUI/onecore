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
  The configuration response advertises `permissions.canUpdateSettings` for
  form visibility; PATCH authorization remains server-enforced. Read-only
  users can view the profile without edit forms. Lifecycle/name mutation and
  arbitrary JSON rendering are not supported.

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
  navigation. Each member row exposes branch access details; authorized
  operators can add/remove assignments for active `ASSIGNED` memberships.
  `ALL` access is displayed read-only. UI capability flags are informative
  only; mutation APIs enforce permissions and lifecycle constraints.
- **Verification:** API tests cover route authorization, denial auditing,
  branch-code validation, assignment idempotency, tenant/lifecycle checks,
  and RLS. `npm test` passes with 267 tests passed and 3 skipped;
  `npm run typecheck`, `npm run lint`, and `npm run build` pass.
  `npm run format:check` still reports only `apps/business/app.js`; checking
  the committed version of that file also fails, so this is existing
  formatting drift rather than a regression from the branch-assignment work.
- **Browser verification:** `npm run test:e2e` passes against a disposable
  PostgreSQL 18.6 database with synthetic identities and organizations. The
  Playwright/Chromium journey uses the real API, centralized authorization,
  and persistence path; it verifies invalid login (`401`), authorized sign-in
  and organization selection, profile update persistence, branch creation
  persistence, branch assignment and removal persistence, read-only mutation
  denial, self-target denial, cross-organization concealment, invalid and
  foreign-tenant branch denial, and loading/empty/success UI states. Disposable
  database assertions confirm all four relevant repository migrations were
  recorded, forced RLS, migrator ownership, non-superuser/non-`BYPASSRLS` app,
  worker, and migrator roles, and restricted session-column insert
  privileges. No production credentials or data are used.
- **Migration status:** Disposable migration replay and permission backfill
  evidence does not establish the state of a deployed database. The
  deployment migration history remains unreconciled pending authorized,
  read-only evidence from its migration owner. Do not edit historical
  migrations, manually advance a ledger, or claim deployment recovery is
  complete. The repository-wide formatting check still fails on the same
  pre-existing `apps/business/app.js` drift present at `HEAD`. Phase 9
  therefore remains `IMPLEMENTED — VERIFICATION PENDING`.

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
  and transient failures remain visible; create/update/deactivate controls
  follow the list API's advisory capability flags. Mutation routes still
  enforce the permissions and effective data scopes independently; no
  browser-stored business records.

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
  pagination, detail, create/edit, and confirmed deactivation. Mutation
  controls follow the API's advisory capabilities and remain subject to
  server-side permission and data-scope checks.

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

## Frontend verification and remaining scope

The Business app combines the Dashboard/overview, Business profile,
organization settings, Customers, Products & services, Branches, and Users &
members screens with the existing authenticated session and selected
organization/branch context. Its member directory supports the documented
role and branch assignment operations; it does not create invitations or
change membership lifecycle. The audit-log screen explicitly reports that no
tenant-authorized audit read API exists. Dashboard counts and summaries come
from session, entitlement, notification, and workflow APIs; they are not
sales, inventory, or uptime metrics.

### Existing screen inventory

| Screen                                    | API-backed behavior                                                                                                                            | Remaining product/API boundary                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Overview                                  | Authenticated session, installed modules and organization entitlements, notification previews, and workflow-execution previews.                | No sales, stock, finance, or health metrics are inferred or fabricated.                                             |
| Business profile                          | Reads `/organizations/:organizationId/configuration`; updates supported contact, address, legal identity, and regional fields through `PATCH`. | Read-only users see fields without edit forms. Organization rename/lifecycle editing is unsupported.                |
| Organization settings                     | Reads and updates supported country, currency, time zone, locale, and scalar business settings through the configuration API.                  | UI visibility is advisory; PATCH enforces permission. Opaque JSON, secrets, and unsupported fields are not exposed. |
| Customers                                 | Organization-scoped customer list, search, create, update, and deactivate through `/business/customers`.                                       | Capability flags only control affordances; every operation is independently authorized by the API.                  |
| Products & services                       | Organization-scoped catalog list, search, create, update, and deactivate through `/business/catalog`.                                          | This is a master-data catalog, not stock, pricing execution, or sales.                                              |
| Branches                                  | Lists, creates, and updates branches using the branch API, with pagination and active/inactive status.                                         | No hard-delete operation is exposed; branch selection remains session-bound.                                        |
| Users & members                           | Lists members and reads/assigns/removes roles and explicit branch assignments through the member and membership APIs.                          | No invitation creation, membership lifecycle editing, or `ALL`-mode assignment mutation UI.                         |
| Notifications                             | Lists authorized notifications, marks them read, and reads/updates notification preferences.                                                   | Delivery policy and provider operations remain server-owned.                                                        |
| Workflow activity                         | Reads authorized workflow execution history and status.                                                                                        | No workflow creation, editing, or retry action is exposed here.                                                     |
| Communication templates and deliveries    | Read-only organization-scoped template and delivery listings.                                                                                  | No template editing or message-sending workflow is exposed.                                                         |
| Modules, roles, permissions, and features | Reads the existing module registry, organization entitlements, role/permission catalogs, and feature configuration APIs.                       | These screens do not grant entitlements, edit roles, or mutate feature configuration.                               |
| Account profile and security              | Reads the current authenticated session and supports the existing password-change and logout flows.                                            | No active-session revocation UI or self-service identity editing.                                                   |
| Audit log                                 | Shows the explicit unsupported-state boundary.                                                                                                 | No tenant-authorized audit-log read API exists, so no audit data is synthesized.                                    |

Frontend/API integration tests use a disposable PostgreSQL database and
synthetic identities. The Chromium journey verifies profile and regional
settings updates, customer and catalog create/update/deactivate persistence
after reload, branch creation and member role/branch assignment/removal
persistence, plus read-only action visibility for resources, profile, and
settings and server-side denial. The focused API test also verifies that a
settings-read-only session receives `canUpdateSettings: false` and is denied
PATCH. This does not verify any deployment database's migration ledger,
permission backfill, or production availability; see the roadmap for those
outstanding checks.

## Future module integration

Business Manager does not own stock quantities, warehouse locations, stock
movements, purchases, sales transactions, payments, accounting entries, or
analytics. Future modules should reference customer/catalog IDs rather than
duplicate master data, register through the existing module and entitlement
system, and define their own transaction and security contracts. The backend
remains authoritative for every direct URL and mutation.
