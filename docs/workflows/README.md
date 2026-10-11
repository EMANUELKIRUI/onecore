# Workflow foundation

Organizations own versioned `workflow_definitions`; each active definition
executes only its currently published version. Workflow steps, transitions,
triggers, conditions, actions, executions, and action progress are
organization-scoped. Published versions remain immutable. The API validates a
draft before activation, and the runtime validates configuration again before
execution.

## Supported runtime

The event dispatcher schedules workflows only for the registered Phase 18
events:

`ORGANIZATION_CREATED`, `ORGANIZATION_ACTIVATED`, `USER_CREATED`,
`USER_INVITED`, `USER_ROLE_CHANGED`, `MODULE_ENABLED`, `MODULE_DISABLED`,
`CONFIGURATION_CHANGED`, and `FEATURE_FLAG_CHANGED`.

Each execution is linked to its tenant-owned source outbox event and published
version. A unique organization/version/event key prevents duplicate runs.
Execution creation, action-progress rows, the idempotent workflow job, audit,
and job-enqueued outbox record are written in the existing dispatch
transaction. Workflow notification and job events are excluded from the
trigger registry, preventing recursive notification loops.

Conditions use the existing finite operators (`EQ`, `NE`, `LT`, `LTE`, `GT`,
`GTE`, `IN`, `CONTAINS`) on fields in each registered event's strict payload
schema. Only top-level fields are supported. Unsupported event types, fields,
operators, transition graphs, or configurations fail closed; configuration
is never interpreted as JavaScript, SQL, or a template expression.

Only `NOTIFICATION` executes. Its bounded inert title/body and typed recipient
(`ACTOR` or a registered event's `userId`) go through the existing
tenant-authorized in-app notification path, including active recipient
membership, branch eligibility, preferences, audit, and the transactional
notification event. No email/SMS/WhatsApp provider is called. Message content
and recipient data are not copied to execution history.

`workflow_executions` stores the source event ID, branch, lifecycle status,
timestamps, and a safe failure code. `workflow_execution_actions` tracks each
configured action's status, attempts, timestamps, and safe failure code.
Both resources remain tenant-scoped; the action table uses forced RLS and
least-privilege grants. Workflow/action effects are protected against event
redelivery and job retry through source-event uniqueness and atomic action
progress plus notification writes.

## Authorization and API

Event scheduling requires the existing `core.configuration` entitlement and
`core.organization.workflows.manage` permission. Notification actions
revalidate the saved, non-secret dispatch principal's live session, active
membership, organization, branch, module entitlement, workflow permission,
and `core.organization.notification_inbox.manage` permission before writing.
Invalid or expired authority fails closed. No workflow receives the event
actor's authority implicitly.

Event dispatch is explicit through the permission-protected
`POST /organizations/:organizationId/events/dispatch` API; the repository
does not run an automatic dispatcher or scheduler. The API registers workflow
handlers alongside webhook handlers, and each handler still fails closed
without its required entitlement and permission.

The authenticated API exposes:

- `GET /organizations/:organizationId/workflow-executions?limit=&offset=`
- `GET /organizations/:organizationId/workflow-executions/:executionId`

Both require `core.organization.workflows.read`, the `core.configuration`
entitlement, verified organization membership/lifecycle, and an SQL data-scope
predicate. Branch-scoped users see only executions for their verified branch;
organization-level executions are not exposed to branch-only scopes. Responses
contain only workflow/version, registered event type, status/timestamps, safe
failure codes, and action status/type. They do not include event payloads,
notification content, recipient IDs, job payloads, secrets, or authorization
internals.

## Jobs and operational boundary

The event handler inserts a deterministic `core.workflow.execute` job into
the existing tenant job queue in the same transaction as execution creation.
`services/worker` is a separate executable that registers the existing
`createWorkflowJobHandler` and invokes the existing job service. It discovers
active organization IDs under a dedicated worker-only RLS policy, discovers
branches inside each organization context, and claims jobs through the
tenant-scoped `FOR UPDATE SKIP LOCKED` path. It does not add a queue, scheduler,
or webhook/communication delivery transport.

Build and run locally from the repository root:

```sh
npm run build:worker
DATABASE_URL='postgresql://<worker-login>@<host>:5432/<database>' \
  npm run start -w @onecore/worker
```

Use a secret-managed worker-specific database URL, not the API or migration
credential. `WORKER_POLL_INTERVAL_MS` defaults to `5000` (allowed range
`250..60000`), `WORKER_CONCURRENCY` defaults to `4` (allowed range `1..16`),
and `WORKER_SHUTDOWN_GRACE_MS` defaults to `30000` (allowed range
`1000..120000`). `DATABASE_URL` and the shared `LOG_LEVEL` are validated at
startup. Invalid configuration or an unavailable database fails startup with
a nonzero status; connection strings and payloads are not logged.

Before applying the worker-discovery migration, provision a non-login group
role and a separate login through the database administrator/secret manager.
The group role must be `NOSUPERUSER NOBYPASSRLS`, and the login should be
granted membership in that role. Do not grant membership in `onecore_app` or
`onecore_migrator`. The migration gives `onecore_worker` only column-scoped
active-organization discovery and the table/column grants required by workflow
execution; tenant records remain under forced RLS and transaction-local
organization/branch context. Store the worker login URL separately from API
credentials. See the [deployment runbook](../deployment/README.md#workflow-worker).

The worker logs `worker.ready` only after database connectivity and tenant
discovery succeed. It emits structured claim/outcome, polling, error, and
shutdown events; process liveness is the process supervisor's responsibility.
There is no HTTP health endpoint. On `SIGTERM`/`SIGINT` it stops polling,
finishes active database transactions within its grace period when possible,
then closes the database pool. If externally killed during a handler, the
transaction rolls back and the persisted lease becomes reclaimable after
expiry.

Processing is **at-least-once**, not exactly-once: a crash after an external
side effect but before the transaction commits can cause another attempt.
Workflow notification effects are transactional with action progress and use
existing idempotency controls; future handlers must make non-transactional
effects independently idempotent. Multiple worker instances may share the
same worker role and safely compete for persisted leases. Increase concurrency
only after measuring database pool and transaction capacity; each process
bounds its connections based on its configured concurrency. Monitor
`worker.poll.completed`, repeated `worker.scope.failed` /
`worker.discovery.failed` events, retry/failure outcomes, and authorized
tenant-scoped queue status. A growing eligible queue with no recent
`worker.ready` or poll events indicates an unavailable or stuck worker.

Automated PGlite tests continue to cover dispatch and workflow authorization.
The separate PostgreSQL integration suite exercises persisted workflow
execution, tenant-context filtering, concurrency, retry/failure, lease expiry,
and recovery when run against a disposable PostgreSQL instance. Neither local
integration results nor a Render blueprint prove that production services,
secrets, PostgreSQL roles, monitoring, or restart behavior have been deployed
or verified.

The configuration capability resolver reports `workflowExecution: true` for
all supported deployment types because bounded workflow runtime code is
implemented for each. This is an informational code-support capability, not
an entitlement, authorization decision, worker-health signal, or production
readiness claim. Dispatch and job execution continue to require the existing
module entitlement, permissions, verified tenant context, and database RLS
protections.

Phase 18 supersedes ADR 0008's pre-Phase-18 statement that workflow execution
was future work by adding bounded event-triggered execution code. A registered
handler or persisted job does not prove a worker or scheduler is deployed or
running. Production workflow execution remains unverified until its
worker/scheduler is configured and operationally tested; see the
[configuration capability notes](../configuration/README.md#deployment-model).

## Safety boundaries

Workflow metadata is inert data. `APPROVAL` is authorable legacy metadata but
is rejected by Phase 18 activation/runtime; approval processing is not
implemented. Scheduled/manual/webhook triggers, arbitrary event names,
external providers, visual editing, business-record mutation, and cross-tenant
workflows remain out of scope. See the [canonical roadmap](../architecture/roadmap.md)
for the complete Phase 18 scope and production limitations.
