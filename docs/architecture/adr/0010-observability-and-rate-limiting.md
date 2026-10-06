# ADR 0010: Shared observability and PostgreSQL rate limiting

- Status: accepted
- Date: 2026-10-06

## Context

The API already uses Pino, Fastify, append-only `audit_logs`, transaction-local
tenant context, and the PostgreSQL transactional outbox. Authentication had a
process-local login limiter, which did not coordinate multiple API instances.
The platform needs request correlation and safe readiness diagnostics without
introducing another audit/event system or assuming an external provider.

## Decisions

- Keep Pino as the structured logging implementation and add validated request
  and correlation IDs at the Fastify boundary. These identifiers never provide
  authenticated identity or tenant scope.
- Reuse existing audit rows for meaningful security changes, including the
  first over-limit transition for a rate-limit bucket. Do not emit a separate
  event for every rejected request.
- Store only SHA-256-derived rate-limit subject keys and counters in
  PostgreSQL. Use atomic upserts, transaction-local organization context for
  tenant buckets, explicit forced RLS policies, and existing least-privilege
  application-role grants.
- Fail closed if the shared PostgreSQL limiter cannot enforce its limit.
- Keep liveness independent of dependencies and readiness dependent on a
  safe PostgreSQL connectivity probe. Do not expose dependency details.
- Do not claim integration with external logging, metrics, tracing, or alerting
  infrastructure.

## Consequences

All API replicas sharing the same PostgreSQL database share login limits.
Global unauthenticated limits are keyed by server-derived source IP; callers
can use organization-specific buckets only when they have a verified tenant
context. PostgreSQL stores transient limiter state, so the platform cleans
expired rows in bounded batches.

This is not volumetric edge protection and does not replace MFA, security
monitoring, TLS ingress controls, or production operations. PostgreSQL outage
causes login throttling to fail closed.
