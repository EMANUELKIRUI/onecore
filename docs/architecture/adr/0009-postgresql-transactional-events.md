# ADR 0009: PostgreSQL transactional events

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

Platform configuration and entitlement mutations need durable, tenant-scoped event contracts without creating a state/event consistency gap or introducing a broker dependency. The platform already has PostgreSQL transactions, forced RLS, append-only audit, and one canonical outbox table.

## Decision

- **STATE CHANGE + AUDIT + OUTBOX EVENT = ONE TRANSACTION.** State, its audit mutation, and the outbox insert commit or roll back together.
- Reuse `outbox_events`; do not create a parallel outbox or audit store.
- Validate envelopes and strict payloads against the central versioned Zod registry before insertion and again before dispatch. Reject oversized or secret-bearing metadata.
- Dispatch with bounded PostgreSQL batches and `FOR UPDATE SKIP LOCKED`; use per-handler uniqueness for idempotency.
- Keep organization/branch RLS and authorization checks in force for dispatch, reads, and replay. Events are infrastructure contracts, not an authorization bypass.
- Retry only transient failures with bounded exponential backoff. Dead-letter permanent failures and audit retry, failure, and replay activity.
- Keep business-domain events and external brokers out of scope until their owning modules and consumers are implemented.

## Consequences

Configuration, feature assignment, role assignment, and module entitlement transitions can be published atomically and consumed by trusted registered handlers. Outbox and processing state remain observable and replayable under permission and tenant checks. Organization creation/activation and user creation/invitation contracts remain unwired Phase 8 blockers: their canonical production mutation paths do not exist, and seed/bootstrap fixtures are not substitutes. They can be published only when corresponding state and audit writes share an authorized transaction with the existing outbox. Runtime platform behavior depends on a configured PostgreSQL connection; live role ownership, RLS, and concurrency verification must be performed against PostgreSQL, not inferred from PGlite alone.
