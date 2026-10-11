# OneCore Business OS Roadmap

This document is the canonical source for upcoming phase scope. Existing
architecture documents, ADRs, and implementation guides remain the historical
record for Phases 1–17; this roadmap does not rewrite their definitions or
retroactively assign status labels. See the [architecture overview](overview.md),
[architecture decisions](adr/), and the [communications foundation](communications.md)
for the recorded platform foundations.

## Business Manager Frontend

### Status

IMPLEMENTED — ISOLATED LOCAL VERIFICATION PASSED; DEPLOYMENT VERIFICATION PENDING

### Scope and evidence

The existing authenticated Business app provides the verified-API Dashboard,
Business profile and settings, customer and product/service CRUD, branch
administration, the member directory, member role and branch assignments, and
supported workflow activity. Resource data is read from the real API; no
business records or operational metrics are mocked. Customer/catalog and
branch/member mutation controls use server-returned capability flags as a UI
hint only. Configuration reads likewise expose an advisory
`permissions.canUpdateSettings` flag so read-only users do not see profile or
settings edit forms. The API independently enforces tenant, entitlement,
permission, branch, and data-scope authorization.

The focused frontend suite and Business Manager API integration suite pass.
`npm run test:e2e` passes the Chromium journey against a disposable PostgreSQL
18.6 database and the real API with synthetic identities. It verifies
organization profile and regional settings updates, customer and catalog
create/update/deactivate persistence after reload, branch creation persistence,
member role and branch assignment/removal persistence, read-only action
visibility for resources, profile, and settings, and API rejection of
unauthorized and cross-tenant operations. A settings-read-only API regression
test verifies the advisory flag is false and that PATCH remains denied. This
is local test evidence, not a deployment test.

### Outstanding work and limits

- Deployed migration history and permission backfill remain unverified. Follow
  the read-only reconciliation procedure in
  [`database/migrations/README.md`](../../database/migrations/README.md);
  do not infer production state from local migration replay.
- There is no tenant-authorized audit-log read API, member invitation UI, or
  membership lifecycle editor. The app does not invent these operations.
- Organization display-name/lifecycle editing and active-session revocation
  are not exposed by the existing supported contracts.
- Production availability, deployed assets/API compatibility, and deployed
  authorization grants have not been verified. Do not treat the Business
  Manager UI or branch-administration phase as production-ready.

## Membership and Branch Administration

### Status

IMPLEMENTED — VERIFICATION PENDING

### Scope

Organization branch administration reuses the existing `branches` table and
adds tenant-authorized listing, creation, update, code uniqueness, soft status
changes, pagination, and the existing Business app interface. Membership
branch administration reuses `membership_branches` and exposes separate
organization-scoped read, assign, and remove permissions. Effective access
reports active branches for both `ASSIGNED` and `ALL` membership modes;
explicit assignment mutations are rejected in `ALL` mode. Changing the mode
remains a trusted, separate operation and is not exposed by these routes.

### Evidence and Remaining Work

- The current `main`/`origin/main` baseline already contains the member
  directory, branch CRUD API, branch UI, branch-code validation, and
  insufficient-scope denial audit behavior.
- Membership branch API tests pass through both route/RLS fixtures and the
  centralized authorization service, including read-only denial, distinct
  branch permissions, idempotent assignment, invalid/inactive/cross-tenant
  references, `ALL` conflicts, self-target denial, removal, and audit records.
- `npm run test -w @onecore/api -- tests/business-manager.test.ts` passes
  (5 tests); `npm run typecheck -w @onecore/api` and
  `npm run typecheck:test -w @onecore/api` pass. The Business app frontend
  suite passes (15 tests). The latest full `npm test` passes with 267 tests
  passed and 3 skipped; full typecheck, lint, and production build also pass.
- `npm run format:check` remains failing only for `apps/business/app.js`.
  Running the same Prettier check against `HEAD:apps/business/app.js` also
  fails; the formatter differences are pre-existing, not introduced by this
  work. Other changed files pass a targeted Prettier check. The unrelated
  baseline formatting was not rewritten.
- PostgreSQL 18.6 accepted the full migration chain using
  `onecore_migrator` with `NOSUPERUSER NOBYPASSRLS`. The new assignment
  migration also succeeded as that role with existing Owner/Admin rows and
  left affected tables owned by the migrator with forced RLS enabled.
- Replaying the existing `20261010020000_branch_administration_contract`
  role-permission backfill with pre-existing system roles fails as
  `onecore_migrator` because the cross-tenant insert violates forced RLS on
  `role_permissions`. The forward-only
  `20261010040000_branch_permission_backfill_repair` migration now backfills
  the branch and membership-branch permissions one tenant at a time. Its
  idempotency was tested against two tenants in PGlite and its tenant-scoped
  execution was tested in disposable PostgreSQL 18.6 after the assignment
  migration.
- The disposable E2E database completed the ordered migrations as
  `onecore_migrator` with `NOSUPERUSER NOBYPASSRLS`; its ledger contains the
  three branch-related migrations and
  `20261010140000_session_revoked_at_insert_grant`. Catalog checks confirmed
  forced RLS and migration-role ownership for `roles`, `role_permissions`,
  `branches`, `membership_branches`, and `sessions`, non-superuser/non-bypass
  flags for app, worker, and migrator roles, and the narrow session insert
  privileges. This is local disposable-database evidence, not deployment
  evidence.
- The deployment migration ledger remains unknown. The ordered migration
  runner cannot reach migration `20261010040000` if migration `20261010020000`
  is still unapplied and fails on existing roles; that predecessor must be
  reconciled based on the actual deployment ledger before continuing. Do not
  edit the historical migration or manually advance a ledger without that
  evidence.
- Branch administration and membership assignment remain
  `IMPLEMENTED — VERIFICATION PENDING` because deployed migration history
  remains unreconciled. The Playwright/Chromium journey passes via
  `npm run test:e2e` against a disposable PostgreSQL 18.6 database, synthetic
  identities, the real API, centralized authorization, and the static
  Business app. It verifies invalid and valid login, organization selection,
  profile/settings and customer/catalog create-update-deactivate persistence,
  branch and member role/branch assignment/removal persistence after reload,
  read-only mutation-action visibility and API denial, self-target denial,
  cross-organization concealment, invalid/foreign-tenant branch denial, and
  loading/empty/success UI states. It also verifies forced RLS, table
  ownership, non-superuser/non-`BYPASSRLS` runtime and migrator roles, and
  restricted session-column grants. No live production database or
  deployment migration ledger was accessed.
- The E2E journey creates synthetic users, roles, and permission grants after
  replaying migrations so the API can be exercised. Those fixture grants do
  not verify the migrations' Owner/Admin permission backfill; deployment
  backfill status remains pending the authorized evidence below.
- E2E uncovered the database-backed login rate limiter and failed-login
  lockout paths passing JavaScript `Date` objects through raw SQL template
  expressions; both now serialize timestamps explicitly, with persistence
  regression coverage. It also exposed that Drizzle's session INSERT includes
  generated `id` and default `revoked_at` columns, requiring a forward-only,
  column-scoped grant. The migration and E2E role-privilege assertion preserve
  table-level least privilege and forced RLS.
- Full verification currently reports `npm test` with 267 passed and 3
  skipped; `npm run typecheck`, `npm run lint`, `npm run build`,
  `npm run test:e2e`, `node --check apps/business/app.js`, and
  `node --check scripts/business-manager-e2e.mjs` pass. `git diff --check`
  passes. `npm run format:check` still fails only on
  `apps/business/app.js`, and the committed `HEAD` version fails the same
  check. No production migration ledger was inspected; the migration owner
  must still provide the read-only evidence described in
  `database/migrations/README.md` before deployment migration recovery can be
  considered verified.
- The migration owner must provide the target environment's four relevant
  Drizzle ledger rows and schema, per-tenant Owner/Admin presence/absence
  evidence for all six branch permissions, and RLS/table-owner/runtime-role
  privilege evidence, including session insert privileges, before choosing
  the documented recovery route in `database/migrations/README.md`. Until
  then, deployed migration state and recovery remain unverified.
- **Production readiness:** Not established. Passing code checks and
  disposable-database/browser verification do not substitute for authorized
  deployment migration reconciliation and its security evidence.

## Sales/POS

### Status

IMPLEMENTED - DISPOSABLE DOMAIN, PERSISTENCE, API, AND ORDERED-MIGRATION TESTS PASSED; TARGET MIGRATION APPLICATION AND DEPLOYMENT VERIFICATION PENDING

The current foundation records immutable, unpaid `OPEN` sales from active
catalog items. It includes exact server-side totals, branch-scoped create/list/
detail APIs, line snapshots, organization-scoped idempotency, forced RLS,
central permission/entitlement checks, audit, and an atomic `SALE_CREATED`
outbox event. The `core.sales` module has no automatic plan eligibility,
organization entitlement, or role backfill; trusted product activation and
explicit RBAC grants are still required before use.

There is no authoritative inventory balance or movement model, so the API does
not reserve/decrement stock or prevent overselling. There is no payment
provider, tax or discount policy, accounting integration, finalized sale state,
receipt numbering, or receipt API. `OPEN` means unpaid. The POS frontend is not
wired to the endpoint, and no successful sale should be shown by the UI until
an authoritative API response is implemented there. For retry after an
uncertain timeout, clients must reuse the original idempotency key.

The new migration `20261010184156_sales_checkout_foundation` was replayed in
disposable PGlite tests only. No external migration ledger was inspected and
the migration was not applied to a deployment. The documented
`20261010020000_branch_administration_contract` forced-RLS backfill failure
remains a prerequisite if absent from a target ledger; do not skip it, edit it,
or infer success. Production readiness is not established. See the [Sales
module boundary](../modules/sales.md) and [ADR 0015](adr/0015-sales-transaction-foundation.md).

## Phase 18 — Workflow Execution and Automation Foundation

### Status

IN PROGRESS

The separate workflow worker executable, PostgreSQL-backed job processing,
worker-role discovery migration, and local deployment foundation are
implemented. Unit tests and isolated PostgreSQL integration tests are being
used to verify runtime behavior. This is not a production-readiness status:
production role provisioning, migration application, service deployment,
monitoring, and operational recovery remain unverified and require an
operator-led release.

### Objective

**Business objective:** Let an organization turn explicitly supported platform
events into simple, auditable in-app notifications using its existing
versioned workflow configuration.

**Technical objective:** Safely execute published tenant workflows through the
existing event dispatcher, transactional outbox, job queue, authorization,
notification, and RLS boundaries. Workflow configuration remains inert data:
only registered event triggers, condition operators, and action handlers may
run.

This phase follows Phase 17 because OneCore now has provider-neutral
communications contracts and queueing, in addition to the earlier workflow
metadata, transactional event, job, tenant-isolation, and in-app notification
foundations. Workflow definitions and actions were metadata before this phase;
this phase adds bounded execution without starting a business module or
enabling external provider delivery.

### Scope

#### In scope

- Execute active workflows using their single currently published version.
- Start executions only from the existing registered platform event contracts:
  `ORGANIZATION_CREATED`, `ORGANIZATION_ACTIVATED`, `USER_CREATED`,
  `USER_INVITED`, `USER_ROLE_CHANGED`, `MODULE_ENABLED`, `MODULE_DISABLED`,
  `CONFIGURATION_CHANGED`, and `FEATURE_FLAG_CHANGED`.
- Evaluate workflow conditions deterministically using the existing finite
  operator set (`EQ`, `NE`, `LT`, `LTE`, `GT`, `GTE`, `IN`, and `CONTAINS`)
  against fields exposed by the selected registered event contract. Unknown
  event types, fields, operators, malformed configurations, and unsupported
  actions fail closed.
- Execute the existing `NOTIFICATION` action through the existing
  tenant-authorized in-app notification service. Resolve recipients only from
  the triggering actor or a typed recipient identifier explicitly exposed by
  that event contract, and revalidate active membership and any branch scope.
  Notification text is inert bounded content; arbitrary interpolation,
  executable expressions, and recipient addresses are not supported.
- Persist execution and action progress with stable source-event/action
  idempotency, safe failure state, and auditable lifecycle transitions.
- Provide tenant-authorized APIs to inspect workflow execution history and
  status. Continue to use the existing workflow read/manage permissions for
  metadata and execution operations; do not expose execution data through
  client-supplied tenant or branch identifiers.
- Add a small accessible business-app execution-history/status surface. It is
  operational visibility only; the API remains the authorization authority.

#### Out of scope

- POS, inventory, sales, accounting, finance, payroll, CRM, or any other
  business module or business-record mutation.
- Executing `APPROVAL` metadata, creating an approval lifecycle, or changing
  role/permission/entitlement state as a workflow action.
- Scheduled, manually started, or arbitrary webhook-triggered workflows.
- Triggers from notification-created or communication-queued events; excluding
  these prevents self-triggering notification loops.
- Email, SMS, WhatsApp, webhook, payment, or other external side effects.
  Phase 17 provider interfaces, Phase 16 webhooks, and `SecretStore` are not
  production transports or credentials implementations.
- User-supplied code, scripts, SQL, shell commands, dynamic module loading,
  arbitrary expressions, or arbitrary network requests.
- A visual workflow designer, customer-specific workflow language, workflow
  marketplace, extension runtime, or new general-purpose job/scheduler system.
- Changes to historical Phase 1–17 definitions or status.

### Architecture

Keep the existing direction: UI → API → centralized authorization →
application/domain services → database → transactional events/jobs. Add a
workflow application/runtime service behind the API and event-dispatch
boundary; do not put workflow rules in route handlers, UI code, or migration
triggers.

Resolve definitions from the active organization and currently published
version. The runtime validates every trigger, condition, and action against
static registered contracts before activation and again before execution.
Each permitted action must have a reviewed server-side handler. No stored
configuration is evaluated as code.

Use the existing `core.configuration` module entitlement and canonical
permission catalog. Workflow activation is an explicit, audited organization
management operation. A workflow may only perform the bounded in-app
notification effect declared in this phase; it must not acquire broader
authority from an event payload or a platform role.

### Database

Reuse `workflow_definitions`, `workflow_versions`, `workflow_steps`,
`workflow_triggers`, `workflow_conditions`, `workflow_actions`,
`workflow_executions`, `outbox_events`, `jobs`, `job_attempts`, and the
existing audit and notification tables.

Add an additive migration for the minimum missing execution state needed to
link a run to its source event and persist per-action progress and idempotency.
Use organization-scoped composite foreign keys, appropriate uniqueness and
indexes, valid lifecycle constraints, and forced RLS with the existing tenant
policies and least-privilege grants. Preserve the event's verified branch on
the execution where present. Do not add another outbox or queue.

All state changes, audit records, and any newly emitted event must commit
atomically where they represent one mutation. Never edit an applied migration.

### Domain

Add typed workflow trigger, condition, execution, action-result, and lifecycle
contracts in `@onecore/core-domain`. Keep evaluation deterministic and bounded
by existing size/count limits. The only executing action in this phase is
`NOTIFICATION`; `APPROVAL` remains accepted as inert configuration only if
existing authoring compatibility requires it, and must be rejected for
execution.

Use explicit terminal, retryable, and skipped outcomes. Repeated delivery of
the same source event cannot duplicate an execution or notification action.
Published workflow versions remain immutable; a new version is required for
configuration changes.

### API

Retain the existing authenticated workflow definition/version APIs. Add
authorized, tenant-scoped execution-history/status reads and safe execution
response schemas. The API must validate the active session, organization
membership/lifecycle, branch context, `core.configuration` entitlement,
workflow permission, data scope, and target identifiers before returning
records.

Do not add a client-facing endpoint that accepts arbitrary event payloads to
run a workflow. Do not return internal authorization state, job payloads,
notification body data, secret references, or database details. Use existing
event/job operational recovery paths where available rather than introducing
a parallel retry API.

### Authorization

Reuse centralized authorization and module entitlement resolution; do not
create a workflow-specific role model. Existing
`core.organization.workflows.read` and
`core.organization.workflows.manage` permissions govern workflow and
execution-history operations. Require management permission to activate or
change an executable workflow. Notification actions must use the existing
notification service and its permission checks.

Execution reads apply the existing organization/branch data-scope rules in
SQL. Organization-level events are not exposed to branch-restricted users
unless the existing scope policy explicitly permits them. Every run
revalidates organization lifecycle, module entitlement, event contract,
workflow activation/version, and recipient membership. Missing or ambiguous
scope denies access. A background run never impersonates its source event
actor: the existing notification service must resolve a current verified
authorization context with `core.organization.notification_inbox.manage`
before creating a notification. If that authority is no longer valid, the
action fails closed.

### Tenant isolation

Every execution/action record is tenant-owned and protected with `ENABLE` and
`FORCE ROW LEVEL SECURITY`. Use only verified transaction-local tenant and
branch context. A route organization ID is a consistency check, never a tenant
selector. Preserve same-organization foreign keys and branch relationships.
Missing context, forged context, cross-organization references, inactive
memberships, suspended organizations, branch mismatch, and insufficient
permissions must fail closed.

### Events and Outbox

Register a workflow event handler with the existing versioned dispatcher.
Event-to-execution scheduling and handler processing state use the existing
transactional outbox and idempotent event-processing records. The workflow
handler may enqueue execution work in the dispatch transaction but must not
perform effects outside the transaction.

Do not include notification content, recipient addresses, credentials, or
secret references in events or audit metadata. Do not subscribe this runtime
to events emitted by its own notification action.

### Jobs

Use the existing tenant-scoped job service, claims, leases, retries,
dead-lettering, and idempotency. Execute notification actions only after the
job-claim transaction has committed. Recheck the execution lease and current
organization, workflow/version, module entitlement, and recipient membership
before applying an action. Persist action outcome separately and make retries
safe under at-least-once processing.

No production scheduler or always-on worker is included. The phase must
document the trusted worker invocation and operational dependencies; an
injected job handler is not proof of a deployed worker.

### Localization

Keep event names, stored state, IDs, and API values locale-neutral. Workflow
and notification display text is inert organization-authored content, not
automatically translated. Localize new business-app labels and system status
messages through the existing UI localization helpers, with the currently
supported English and Kiswahili catalogs/fallback conventions. Do not add
country-specific business rules or alter Phase 15 regionalization behavior.

### Integrations

Phase 18 uses internal registered OneCore events and the in-app notification
service only. It does not call integration providers, read `SecretStore`
values, deliver webhooks, or add network egress. Phase 16 and Phase 17
boundaries remain unchanged; external notification delivery remains disabled
until approved production secret, provider, transport, and operational
adapters exist.

### Frontend

Add only the workflow execution-history/status view and permission-aware
navigation needed to operate it. Use `@onecore/ui`, existing application
session/organization/branch context, accessible loading/empty/error states,
and server-resolved authorization. Do not build a second design system or
workflow editor, and do not treat hidden controls as access control.

### Testing

Add focused core-domain, database, API, and UI tests for:

- Valid and invalid trigger/action/condition contracts and unsupported-event
  denial.
- Exactly-once logical execution/effect under duplicate outbox dispatch and
  job retries, including concurrent claims.
- Inactive/unpublished workflow denial and invalid lifecycle transitions.
- In-app notification action validation, active-recipient checks, preference
  handling, and safe audit/event projections.
- Anonymous access, missing tenant context, forged tenant context,
  cross-organization access, inactive membership, suspended organization,
  branch mismatch, insufficient permission, and data-scope enforcement.
- Forced-RLS cross-tenant isolation using the existing PGlite/migration test
  conventions; validate roles/RLS against live PostgreSQL where available.
- UI status rendering, accessible error/empty states, and authorization
  behavior driven by server responses.

### Documentation

Update the workflow, event, API, multi-tenancy, security, and frontend
documentation to describe only implemented behavior and the actual worker
operational boundary. Add the next ADR after ADR 0015 only if implementation
requires a new architectural decision beyond the accepted workflow, outbox,
job, authorization, and notification boundaries. Do not claim production
scheduling, external delivery, or provider connectivity without deployed and
validated adapters.

### Completion Criteria

- Published workflows execute only from the registered event allowlist and
  perform only the bounded `NOTIFICATION` action.
- Trigger, condition, and action configuration is validated and never
  interpreted as code.
- Execution and action progress are tenant-isolated, auditable, and safe under
  duplicate events, retries, and concurrent workers.
- Every API and action enforces current authorization, module entitlement,
  membership, lifecycle, branch, and data-scope requirements server-side.
- New UI exposes status only through authorized APIs and follows existing
  accessibility and localization conventions.
- Focused and required repository validation passes; migrations, RLS policies,
  grants, security tests, and live operational limitations are documented.
- No out-of-scope business module or external provider capability is
  introduced or claimed.

### Dependencies

Phase 18 relies on the implemented foundations recorded across Phases 1–17:
TypeScript/npm workspace boundaries; PostgreSQL/Drizzle and forced tenant RLS;
identity, sessions, organization/branch context; centralized RBAC and
data-scope authorization; module registry and entitlements; configuration and
workflow metadata; audit, transactional outbox, dispatcher, and jobs;
observability; shared UI shell; localization/regionalization; integration and
`SecretStore` boundaries; and Phase 17 communication/content services.

The phase specifically builds on existing workflow metadata and event/job
services; it does not assume a workflow engine, production scheduler, external
communication adapter, secret manager implementation, or production
deployment.

### Production Limitations

The repository does not establish a production always-on job worker,
scheduler, managed PostgreSQL configuration, secret manager, or provider
transport. PGlite tests do not prove production PostgreSQL role, RLS, trigger,
or concurrency behavior. The in-app workflow notification capability must
not be described as production-operational based only on service tests; the
deployment must provision and validate all required worker and database
runtime components before claiming automatic production delivery. There is
currently no tenant-authorized job list/attempt-history API or separate job
dead-letter table: operators rely on structured worker/database logs and
`FAILED` job plus `JOB_FAILED` outbox/audit records. This visibility contract
must be considered during production operational acceptance.

### Future Extensions

Later phases may add approval lifecycle/actions, domain-specific event
contracts, business-resource mutations with per-action authorization and
resource scopes, scheduled triggers, visual editing, external communication
actions, and controlled workflow operations. Each extension requires its own
product scope, event/action contracts, security review, migration and tests;
none is implied by Phase 18.
