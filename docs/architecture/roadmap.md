# OneCore Business OS Roadmap

This document is the canonical source for upcoming phase scope. Existing
architecture documents, ADRs, and implementation guides remain the historical
record for Phases 1–17; this roadmap does not rewrite their definitions or
retroactively assign status labels. See the [architecture overview](overview.md),
[architecture decisions](adr/), and the [communications foundation](communications.md)
for the recorded platform foundations.

## Phase 18 — Workflow Execution and Automation Foundation

### Status

PLANNED

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
foundations. Workflow definitions and actions are still metadata; no workflow
execution engine currently exists. This phase closes that specific gap without
starting a business module or enabling external provider delivery.

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
runtime components before claiming automatic production delivery.

### Future Extensions

Later phases may add approval lifecycle/actions, domain-specific event
contracts, business-resource mutations with per-action authorization and
resource scopes, scheduled triggers, visual editing, external communication
actions, and controlled workflow operations. Each extension requires its own
product scope, event/action contracts, security review, migration and tests;
none is implied by Phase 18.
