# ADR 0004: Opaque server-side authentication sessions

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Phase 2 established global canonical users, organization memberships, tenant-scoped roles, transaction-local PostgreSQL RLS, and an append-only audit log. Phase 3 needs credential authentication and organization switching without duplicating those identity concepts or allowing client-controlled tenant context.

## Decision

- Authenticate passwords with Argon2id using the maintained `@node-rs/argon2` implementation. Store only the encoded password hash on the canonical user. Normalize email by trimming and lowercasing at the API boundary and enforce case-insensitive uniqueness in PostgreSQL.
- Use opaque, cryptographically random 256-bit session secrets in `HttpOnly` cookies. Store only a SHA-256 digest of the secret in the server-side session table. The digest is a lookup verifier, not a password hash; the random source secret has enough entropy to prevent practical offline guessing.
- Set a 12-hour absolute session lifetime, no sliding refresh in this phase, and revoke server-side on logout. Sessions may be concurrent. Authentication does not return the cookie secret in JSON.
- Set `Path=/`, `SameSite=Lax`, `HttpOnly`, and `Secure` in production. Serve production traffic over HTTPS only. SameSite limits cross-site cookie sending; mutation endpoints additionally require JSON requests and validate a supplied `Origin` against the configured origin allowlist. No permissive CORS policy is enabled here. Future cross-origin app deployments must set an explicit allowlist and retain credentialed-origin restrictions.
- Rotate the session secret on login by creating a new session rather than accepting caller-provided session IDs. No session ID is accepted from a request body/header. Revoke the old session on logout. Session fixation is therefore prevented at the authentication boundary.
- Rate-limit login by source IP with Fastify's route-level limiter (5 attempts per minute) and lock an active account after 10 failed password attempts in a 15-minute rolling window for 15 minutes. Use a generic public failure response for unknown, inactive, locked, and wrong-password accounts. The in-process limiter is a single-instance safeguard only; production multi-replica deployments must provide a shared limiter store or equivalent edge rate limit.
- Organization selection is a requested context, not authority. The API verifies active membership and active organization before persisting the selected organization on the session. Memberships and organizations may be listed only under a transaction-local user identity derived from a resolved server-side session. Tenant operations use the membership-verifying Phase 4 context helpers; no route may copy an organization or branch ID into trusted context directly.
- Branch ID is persisted only after Phase 4 verifies active organization membership, organization/branch lifecycle, and the membership's assigned/all branch scope. The branch GUC is transaction-local; future branch-bearing business data still needs branch-aware query predicates/RLS and complete RBAC/data-scope enforcement.
- Authentication events use the existing append-only `audit_logs` table. Its organization reference becomes nullable only for platform-level identity events with `resource='authentication'`; the RLS policy permits tenantless inserts only for this resource. Those rows are not visible under a customer tenant context. Failed attempts do not store passwords, hashes, cookies, or tokens.
- Platform role assignments are separate from organization roles. A platform role does not bypass RLS or grant customer-data access. Time-bounded support access, MFA, recovery, email verification, and credential lifecycle workflows are deferred.

## Consequences

- Session validity and revocation are immediately enforceable by the server, including across API workers sharing PostgreSQL.
- A database compromise does not expose reusable session secrets. Password hashes remain sensitive and must never be selected into public response types or logs.
- Database availability is required to authenticate or resolve a session.
- Rate limiting is not globally coordinated until production supplies a shared store/edge control.
- Organization selection is available without implementing the later role/permission or branch authorization engine.
- Authentication events from unknown identities have no actor or organization; they remain durable platform-level audit events and are hidden from tenant-scoped audit readers.

## References

- [Phase 2 persistence and tenant isolation](0002-postgresql-drizzle-persistence.md)
- [Security foundation](../../security/README.md)
- [Database developer guide](../../../database/README.md)
