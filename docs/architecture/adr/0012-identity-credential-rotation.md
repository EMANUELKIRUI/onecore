# ADR 0012: Identity credential rotation and session revocation

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

The identity foundation uses global users, Argon2id password hashes, opaque
digest-only server sessions, forced RLS, and append-only authentication audit
records. It did not provide an authenticated password-change operation or
invalidate concurrent sessions after a credential change.

## Decision

An authenticated password change requires the current password and a new
password of at least 12 characters. The API verifies the current Argon2id
credential, hashes the replacement with the existing Argon2id parameters, and
passes the expected previous hash to the identity repository.

The repository transaction verifies the live session and active identity,
compares the stored hash to the expected previous hash, updates the credential,
revokes all active sessions for that identity, and writes the
`AUTH_PASSWORD_CHANGED` and `AUTH_SESSIONS_REVOKED` audit records atomically.
The compare-and-set prevents concurrent or stale requests from overwriting a
newer credential. After success the API clears the session cookie; the user
must authenticate again.

Identity ownership and current-session proof are re-established inside the
repository transaction using transaction-local session/user context. The
existing RLS policies remain unchanged. Audit events contain safe request
metadata and a non-secret session row identifier; they never contain either
password, either password hash, or the raw session secret.

No administrative account-disable API is added: account-state changes remain
outside the current public API. Existing `PENDING`, `ACTIVE`, `SUSPENDED`,
`LOCKED`, and `DISABLED` states remain distinct, and only `ACTIVE` accounts
authenticate. Inactive memberships continue to lose organization context
without changing global account state.

## Consequences and boundaries

- Password changes invalidate every active session, including the caller's.
- Existing logout remains per-session; no independent logout-all API is added.
- Password recovery/reset, password history, email verification, MFA, and
  administrative account-state management remain unimplemented. Recovery
  delivery requires a later provider-neutral delivery/outbox integration.
- This decision changes no database schema, RLS policy, grant, or platform
  authorization boundary.
