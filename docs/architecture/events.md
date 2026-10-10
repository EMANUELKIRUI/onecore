# Events and transactional outbox

## Contract

Events are versioned infrastructure contracts, not authorization grants. **EVENTS ARE INFRASTRUCTURE CONTRACTS, NOT AN AUTHORIZATION BYPASS.** The central Zod registry in `packages/core-domain/src/events.ts` defines event type, version, strict payload schema, owning module, description, and additive-only compatibility policy. The supported platform contracts are `ORGANIZATION_CREATED`, `ORGANIZATION_ACTIVATED`, `USER_CREATED`, `USER_INVITED`, `USER_ROLE_CHANGED`, `MODULE_ENABLED`, `MODULE_DISABLED`, `CONFIGURATION_CHANGED`, `FEATURE_FLAG_CHANGED`, and the limited unpaid-sale event `SALE_CREATED`. Inventory and other business-domain events remain out of scope.

Each envelope contains an event ID, type and version, occurrence timestamp, organization and optional branch, optional actor, correlation and optional causation IDs, aggregate identity, payload, and inert metadata. The complete serialized envelope is limited to 65,536 characters. Payload schemas are strict; metadata rejects executable-looking and secret-bearing keys. Treat payloads and metadata only as data. Never place passwords, credentials, tokens, secret references, or integration secrets in an event.

Compatibility is additive within a version. A breaking payload change requires a new registered event version and a matching handler version. Unknown event types, versions, malformed payloads, and oversized envelopes are rejected before outbox insertion and dead-lettered if encountered in stored legacy/corrupt data.

## Transactional outbox

**STATE CHANGE + AUDIT + OUTBOX EVENT = ONE TRANSACTION.** A state mutation, its append-only audit record, and `recordOutboxEvent` must use the same organization transaction. `recordOutboxEvent` validates the envelope, inserts into the canonical `outbox_events` table, and writes `EVENT_CREATED` to the existing audit log. It does not publish after commit. A rollback removes all three; a commit persists all three.

The canonical outbox stores the envelope fields plus delivery status, attempt count, next-attempt time, last error, processing start, created/updated times, and published time. Its envelope columns are immutable; only delivery bookkeeping may change. Pending selection is bounded (25 by default, at most 100) and indexed by organization, delivery status, retry time, and creation time.

Real sources currently include organization settings, custom fields, workflows, notifications, integrations, and custom-domain mutations (`CONFIGURATION_CHANGED`); feature assignment mutations (`FEATURE_FLAG_CHANGED`); role assignment/removal (`USER_ROLE_CHANGED`); and module entitlement transitions (`MODULE_ENABLED` / `MODULE_DISABLED`). Module events are only recorded when the guarded database mutation returns a changed row. Enabling an already-enabled module is rejected before mutation; disabling a non-enabled module has no transition event. Payloads contain only configuration field names, user/membership/role identifiers, the flag key and scope/type, or the module key and entitlement source, never the changed secret values.

## Dispatcher and handlers

The PostgreSQL dispatcher claims eligible rows using `FOR UPDATE SKIP LOCKED` inside the tenant transaction. It validates each envelope, checks organization and branch identity against the verified context, resolves handlers by event type/version, and records handler outcomes before the transaction ends. It requires no external broker. Multiple workers do not claim the same locked outbox row concurrently.

Handlers declare a stable name, event type/version, owning module, optional required module entitlement, and optional required permission. `createEventHandlerRegistry` validates registrations and includes independent `core.audit` handlers. A handler with a missing or disabled entitlement, or missing permission, fails closed and does not execute. The API dispatch route also registers event-specific webhook enqueue handlers; those handlers only create separate tenant-scoped delivery rows for subscriptions that explicitly selected the event. External delivery occurs later in a separately claimed worker, never inside the business transaction. See [integration and webhook architecture](integrations.md) for delivery, retries, signing, and the fail-closed egress boundary.

The API dispatcher also registers the bounded workflow event handler for the
nine registered Phase 18 trigger contracts. It resolves only active workflow
definitions and their published version, writes an idempotent execution plus
one existing-queue job in the dispatch transaction, and excludes
`JOB_*`, `NOTIFICATION_CREATED`, and `COMMUNICATION_QUEUED` events from
workflow triggers. The worker revalidates the published configuration and
executes only the in-app `NOTIFICATION` action through the existing
notification service. It never calls communication providers. Execution and
action statuses are separately persisted and tenant-isolated; workflow history
is exposed only through the authorized execution-history API. See
[workflow foundation](../workflows/README.md).

For each `eventId + handlerName`, `event_processing_records` has a unique key and stores processing status, attempt count, timestamps, and failure details. Handler effects run in a nested transaction/savepoint and successful processing state is recorded in the enclosing transaction. A completed handler is skipped on duplicate delivery. `EVENT_HANDLED` and `EVENT_HANDLER_SUCCEEDED` are written to the existing audit log.

## Retries and dead letters

The default policy permits eight attempts. Retryable infrastructure, temporary database, and handler failures use exponential backoff starting at one second and capped at one hour. The next attempt time and a bounded reason code are stored; event payloads and arbitrary exception text are not copied into failure records. Contract, authorization, module-entitlement, and permanent business-validation failures are not retried and are dead-lettered immediately. Exhausting retryable attempts also dead-letters the handler.

`event_dead_letters` retains the organization, event, handler, failure kind/reason, attempt count, and replay timestamps. Failures, retry scheduling, and dead-lettering are audited. Read and replay routes require `core.organization.events.read` and `core.organization.events.manage`, respectively. Replay runs in the same tenant transaction, is audited, respects handler entitlement checks on subsequent dispatch, and only resets the selected event/handler attempt. It is not a public unrestricted operation.

## Tenant security and tracing

The outbox, processing, and dead-letter records are organization-scoped under forced PostgreSQL RLS; composite foreign keys bind branch and event records to the same organization. A verified tenant context is mandatory, and the dispatcher checks its organization/branch against transaction-local PostgreSQL context before claiming events. Route organization IDs are consistency checks, not tenant selectors. Platform/superadmin identity does not bypass customer RLS. Missing context fails closed; a mismatched stored tenant or branch is not dispatched.

`createDomainEvent` generates a correlation ID unless the caller supplies one. For a follow-up event, preserve the incoming event's `correlationId` and set `causationId` to the source `eventId`. Request-originated event helpers retain the request ID in non-secret metadata. This makes related events traceable without treating correlation identifiers as authorization data.

## Validation and current boundaries

Core-domain tests cover valid envelopes, invalid versions/payloads, executable and secret metadata, and size limits. PGlite persistence tests cover commit/rollback atomicity and forced RLS. The same database tests are useful local checks, but production PostgreSQL role ownership, live concurrent worker behavior, and live replay/RLS security still require validation against the configured PostgreSQL 18.6 instance.

### Production lifecycle mutations

The API provides canonical organization creation and activation, platform user
creation, and organization user invitations. Each successful mutation writes
its state, audit record, and corresponding lifecycle event through one
authorized transaction and the existing outbox. Organization creation begins
in `PENDING`, provisions the existing default role templates, and creates an
`ACTIVE` membership with the `Organization Owner` role for the explicitly
identified bootstrap owner. New bootstrap identities are created as `ACTIVE`
with an Argon2id password hash; existing active identities are reused without
changing their credentials. The platform SUPERADMIN is not automatically made
a tenant member.

Invitation persistence does not send email or SMS. Delivery, acceptance,
credential setup, and invitation-token lifecycle remain separate work; the
ordinary invitation event is the integration point for a delivery consumer.
The development seed remains bootstrap-only and does not publish lifecycle
events. No POS, Inventory, Sales, external broker, or frontend consumer is
introduced by these mutations.
