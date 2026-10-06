# Security foundation

Phase 1 provides validated runtime configuration, secret-file exclusions, Pino structured logging with sensitive-field redaction, and sanitized API errors. Phase 2 added tenant-scoped constraints, forced PostgreSQL RLS, transaction-local organization context, and append-only audit records. Phase 3 adds Argon2id password verification, hashed opaque server-side sessions, cookie protections, login throttling, account lockout, membership-verified organization selection, and authentication audit events. Phase 4 adds session-bound, membership-verified branch selection and tenant/branch integrity checks. Phase 5 adds tenant-scoped RBAC and centralized permission resolution. Phase 6 adds lifecycle- and subscription-aware module entitlement resolution. These controls are a foundation, not a complete security program.

## Identity and tenant boundaries

- `users` is the canonical identity. Email is normalized for lookup and protected by a case-insensitive unique index. Status is one of `PENDING`, `ACTIVE`, `SUSPENDED`, `LOCKED`, or `DISABLED`; only `ACTIVE` accounts authenticate.
- Passwords use Argon2id. The encoded hash is private persistence data and is never returned by API responses. Sessions use random 256-bit cookie secrets; only SHA-256 digests are stored.
- Sessions are server-side, expire after 12 hours by default, and are revocable. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Mutation routes require JSON and validate browser origins; configure `AUTH_ALLOWED_ORIGINS` for production frontends.
- The login route is limited to 5 attempts per source IP per minute by default using a PostgreSQL-backed atomic counter shared by API instances. Rate-limit subjects are hashed before persistence and logs; crossing a limit creates one audit event per bucket window. Database failure does not fall back to a weaker in-memory limit. Ten failed credentials within a 15-minute window lock an active account for 15 minutes.
- A requested organization is accepted only after the live session's user is found in an active membership and the organization is `ACTIVE`. Session organization and branch state are rechecked on every request. Branch access defaults to explicit `ASSIGNED` scope; `ALL` must be granted as a trusted membership setting. A requested branch must be active, belong to the selected organization, and be allowed by the membership.
- `users`, `sessions`, `organization_memberships`, and `organizations` use identity-specific RLS policies as well as tenant RLS. The API sets transaction-local `app.current_login_email`, `app.current_user_id`, `app.current_session_hash`, `app.current_organization_id`, and verified `app.current_branch_id` values from trusted session and membership state. These GUCs are never request claims.
- Platform roles are stored separately from organization roles. `SUPERADMIN` and support roles do not bypass tenant RLS or imply operational customer-data access. The separate registry writer requires a live superadmin session and migration-role connection; it cannot grant tenant-data access. Time-bound audited support access is not implemented.

Never trust client-supplied organization, branch, role, module, or data-scope claims without resolving them through trusted identity and entitlement services. Do not weaken RLS, use a table-owner/superuser/`BYPASSRLS` API connection, or treat the tenant context helper as authentication.

## Authentication logging and audit

The API never logs request bodies or credentials. Pino redacts password, password hash, token, session digest, authorization, and cookie fields. Authentication and module-registry audit events reuse append-only `audit_logs`; tenantless module-registry entries are insertable only by `onecore_migrator`, while the API's customer entitlements are audited in their tenant context. Audit metadata records safe module, version, request, and fixed reason facts, never passwords, hashes, cookies, or tokens.

Structured request/correlation context, generic external error responses, liveness/readiness semantics, rate-limit behavior, and operational limits are documented in [observability and security operations](observability.md).

Obtain DB and deployment secrets from a secret manager. Do not store raw integration credentials in organization/configuration records; persist secret references only. Audit snapshots require service-layer redaction and access controls.

## Deferred controls and residual risks

MFA, password reset, email verification, credential rotation, anomaly detection, controlled support-access grants, payment/billing automation, business-row filtering for `OWN`, `ASSIGNED`, and `CUSTOM` scopes, transport termination, and production security monitoring remain future work. PostgreSQL rate limiting coordinates API instances that share this database but is not a substitute for edge controls against volumetric attacks. PGlite validates migrations and RLS behavior but does not replace verification against the provisioned PostgreSQL service, secret manager, HTTPS ingress, or production deployment.

See [authentication architecture and threat model](authentication.md), [RBAC and authorization](rbac.md), [module entitlement security](module-entitlements.md), [ADR 0004](../architecture/adr/0004-opaque-server-side-authentication-sessions.md), [ADR 0006](../architecture/adr/0006-rbac-and-authorization.md), and [ADR 0007](../architecture/adr/0007-module-registry-and-entitlements.md).
