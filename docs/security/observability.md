# Observability and security operations

OneCore's shared observability foundations use the existing Pino API logger,
Fastify request lifecycle, transaction-local tenant context, append-only
`audit_logs`, and the PostgreSQL outbox. No hosted telemetry provider or
external tracing backend is assumed.

## Request context and logs

Each API request gets a UUID request ID. A valid UUID supplied in
`x-request-id` may be retained; malformed values are replaced with a generated
ID. A valid UUID in `x-correlation-id` is used for correlation, otherwise the
request ID is used. Both identifiers are returned in response headers. These
values identify work only; they do not establish actor, organization, branch,
role, or permission identity. Authenticated actor and verified tenant/branch
values are attached only after session and membership validation.

Request context is available through `getRequestContext()` in asynchronous
request execution. API completion logs contain service/environment, request
and correlation IDs, actor and verified scope when available, route template,
method, duration, and response status. Request bodies, raw search text,
notification content, storage bytes, and job payloads are not logged.

Pino redacts common credential, token, cookie, authorization, database URL,
and secret field names through ten nested object levels. Use
`redactSensitiveFields()` before emitting arbitrary metadata from new
integrations; do not add secrets to audit or event metadata. Request correlation
IDs are diagnostic values, not access-control inputs.

The API propagates correlation IDs through authorization metadata, audit
records, configuration outbox events, platform search/notification events,
and jobs, including enqueue, retry, cancellation, lease recovery, and worker
attempts. Outbox dispatch and job processing retain their existing correlation
IDs. Authentication audit records include request correlation for login and
session create/revoke operations.

Database-backed service telemetry records job lifecycle operations,
notification creation and its `IN_APP` channel, storage provider operations,
and PostgreSQL search operations. Search telemetry omits search terms,
tenant/user identifiers, and document/index identifiers; it records query
length and result count.
Notification title/body/metadata, job payloads, and storage contents are not
included. No external notification or search provider is currently integrated,
so provider-specific delivery telemetry is not available.

## Errors and health

`classifyError()` provides stable categories for validation, authentication,
authorization, not-found, conflict, rate-limit, security, database, external
dependency, and internal failures. The API error handler returns generic
messages and never returns exception messages, SQL, stack traces, or
connection details. Internal errors are logged with their category and
diagnostic exception under Pino redaction.

`GET /health` remains the backward-compatible liveness response.
`GET /health/live` checks only process responsiveness.
`GET /health/ready` performs the configured PostgreSQL connectivity check and
returns only `ready` or `not_ready`; database errors are logged internally.
Health responses are non-cacheable and do not reveal dependency details. A
readiness check must be configured; an unconfigured check returns `not_ready`.

API defaults include a one-megabyte body limit and restrictive content,
frame, referrer, and permissions headers. The API does not enable permissive
CORS. TLS termination and transport policy remain deployment responsibilities.

## Security events and rate limits

Meaningful security state transitions reuse `audit_logs` (authentication
success/failure and session activity, permission decisions, configuration,
role, entitlement, and other existing mutations). The database-backed login
limiter records `security.rate_limit.triggered` on the first request that
crosses a configured bucket limit, in the same transaction as the counter
update. Repeated requests in the same over-limit window do not create duplicate
audit rows. Rate-limit metadata contains a one-way subject hash, not the source
IP or credentials.

`createDatabaseRateLimiter()` uses PostgreSQL upserts for atomic bucket
increments across API instances. Its caller supplies a bounded scope, an
identity (such as the server-derived source IP), configurable limit/window,
and optionally a trusted organization ID. Organization-specific buckets run
inside transaction-local organization context. The table has forced RLS,
explicit global-vs-tenant policies, a migrator-owned schema object, and
application-role DML grants only. Expired buckets are removed in batches of
up to 1,000 during periodic requests. If PostgreSQL cannot enforce a limit, the
API fails closed rather than silently switching to process-local limits.
Production app construction without an injected shared limiter also rejects
login with a generic service-unavailable response.

The runtime uses only the configured PostgreSQL database; no Redis or other
shared rate-limit provider is integrated. Authentication account lockout and
session expiry/revocation remain in the existing identity repository. Opaque
session secrets are never written to audit or telemetry.

## Database and tenant security

`onecore_migrator` remains responsible for schema changes and table ownership;
`onecore_app` has runtime DML privileges only. It must remain non-superuser,
non-owner, `NOBYPASSRLS`, `NOCREATEROLE`, and `NOCREATEDB`. The rate-limit table
is forced-RLS; tenant buckets require the exact transaction-local organization
ID, and global login buckets are accessible only without an active tenant
context. Missing context cannot read or write tenant buckets.

Security event persistence does not create a second audit or event system.
State changes continue to use the existing transactional audit/outbox paths.
Never trust request headers for actor or tenant context.

## Limitations

No external metrics, log aggregation, tracing, alerting, or hosted health
service is deployed. Request context is in-process and database/outbox/job
correlation is propagated only at existing API boundaries; workers still need
to configure their own structured logger and operational exporter. MFA,
anomaly detection, and production ingress/TLS configuration remain deferred.
