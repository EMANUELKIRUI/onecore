# ADR 0014: Integration secret and webhook boundaries

- Status: accepted
- Date: 2026-10-07

## Context

Organization-scoped integration metadata, centralized authorization, forced
RLS, safe audit records, and the transactional event outbox already exist.
The platform has no approved secret manager or SSRF-safe HTTP transport.
Persisting credentials in ordinary database columns or sending arbitrary
configured endpoints from API handlers would cross security boundaries that
the platform does not provide.

## Decisions

- Keep integration credentials out of configuration JSON, normal API
  responses, audit records, logs, and event envelopes.
- Define a tenant- and purpose-scoped `SecretStore` port using opaque
  references. Do not provide a plaintext or database-backed implementation;
  missing secret infrastructure fails closed.
- Keep integration metadata status distinct from connection health. The
  current `PENDING` value is metadata-only and must not imply a connection.
- Persist organization-scoped webhook subscriptions, logical delivery rows,
  and per-attempt results under forced RLS with composite tenant foreign keys.
- Reuse the transactional outbox to enqueue selected webhook events. Perform
  external I/O only in a separately claimed worker after the business
  transaction commits.
- Sign exact raw payload bytes with HMAC-SHA256 and separate timestamp,
  delivery-ID, and versioned signature headers. Enforce a five-minute clock
  window and at-least-once delivery with stable consumer idempotency keys.
- Keep endpoint syntax/range checks separate from transport security. The
  default outbound transport always fails closed; production delivery needs
  DNS pinning, redirect denial/revalidation, TLS, timeout, and response limits.
- Do not add provider-specific integrations in this foundation.

## Consequences

Metadata APIs and persistence are available, but credential use and outbound
delivery require explicitly injected production adapters. Delivery retries
are bounded and dead-lettered with safe reason codes. Secret storage and
database mutations cannot share a distributed transaction; adapters must be
idempotent and operational cleanup must handle orphaned secret versions.
Webhook subscriptions, delivery persistence, credential configuration and
rotation, endpoint egress controls, and provider adapters must be validated
before enabling external delivery in production.
