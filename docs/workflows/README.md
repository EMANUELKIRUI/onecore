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
The exported `createWorkflowJobHandler` uses the existing job claims, leases,
bounded attempts, idempotency, and terminal failure semantics. It does not add
a queue or scheduler.

This repository does not configure a production always-on job worker or
scheduler. A trusted worker must register the exported handler in the existing
job handler registry and invoke the tenant-scoped job service. Without that
worker deployment, workflow jobs remain queued and the API reports their
persisted pending status; no production execution or delivery SLA is claimed.
PGlite tests do not establish live PostgreSQL role behavior or worker
availability.

## Safety boundaries

Workflow metadata is inert data. `APPROVAL` is authorable legacy metadata but
is rejected by Phase 18 activation/runtime; approval processing is not
implemented. Scheduled/manual/webhook triggers, arbitrary event names,
external providers, visual editing, business-record mutation, and cross-tenant
workflows remain out of scope. See the [canonical roadmap](../architecture/roadmap.md)
for the complete Phase 18 scope and production limitations.
