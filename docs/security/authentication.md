# Identity and authentication

## Identity model

The Phase 2 `users` table remains the canonical global identity. It now contains the normalized-login email source, lifecycle status, Argon2id password hash, optional verification timestamp, failed-login window/counter, lock expiry, and last successful login. Membership remains in `organization_memberships`; no second customer-user or account table was added.

Organization roles remain tenant-owned in `roles` and are attached through memberships. Platform roles use the separate `platform_user_roles` table. A platform role is not an organization role, does not grant membership, and does not bypass RLS. The API currently does not implement Superadmin or support authorization.

Account lifecycle transitions are represented by `canTransitionUserAccountStatus`:

```text
PENDING   -> ACTIVE, DISABLED
ACTIVE    -> SUSPENDED, LOCKED, DISABLED
SUSPENDED -> ACTIVE, DISABLED
LOCKED    -> ACTIVE, DISABLED
DISABLED  -> no transitions
```

Only `ACTIVE` authenticates. Automatic lockout may return a time-locked account to `ACTIVE` after the lock window; a `LOCKED` account without an elapsed automatic lock expiry remains locked. This phase has no public endpoint for changing account status.

## Session lifecycle

`POST /auth/login` accepts a JSON email/password pair, verifies the account and password server-side, records failure/success audit events, creates a 256-bit random session secret, and sets it in an `HttpOnly` cookie. Only the SHA-256 digest is persisted. The secret never appears in JSON. Sessions expire after 12 hours by default (configurable from 5 minutes through 24 hours), have no sliding renewal, permit concurrent logins, and are revoked by `POST /auth/logout`.

Cookies use `Path=/`, `SameSite=Lax`, and `Secure` in production. Same-origin JSON mutation requests and the optional `AUTH_ALLOWED_ORIGINS` allowlist mitigate CSRF. Production ingress must use HTTPS. Do not place sessions in browser localStorage or include them in URLs. Login creates a new random session independent of any caller-provided cookie, preventing fixation.

The API resolves sessions centrally in an `onRequest` hook. Expired, revoked, malformed, or disabled-account sessions are anonymous. `GET /auth/session` returns only safe user identity, selected organization and branch IDs, active memberships, and expiration. `requireAuthenticated()` protects routes; `requireOrganizationMembership()` additionally requires a resolved active organization membership. `POST /auth/organization` switches organization only after both active membership and `ACTIVE` organization status are verified; changing organization clears branch state in the same transaction. `POST /auth/branch` selects a branch only after verifying the saved session organization, active membership, active branch ownership, and branch access mode/assignment. Client-supplied organization and branch IDs are requests, never proof of access.

## Tenant context and RLS

Membership discovery uses a transaction-local authenticated user ID obtained from a live server-resolved session. Organization selection verifies active membership and organization state before updating the existing session. Branch selection verifies branch access and writes the branch GUC only inside the same transaction that updates session context and audit. The middleware rechecks membership and organization state on each request, and rechecks saved branch access before exposing it in request context. Tenant services must use membership-verified context helpers; never copy a request value into `app.current_organization_id` or `app.current_branch_id`.

RLS on identity tables permits:

- `users`: the normalized email currently being checked, or the server-resolved user ID.
- `sessions`: the digest currently being resolved/revoked, or sessions owned by the server-resolved user.
- `organization_memberships`: only the resolved user's memberships, in addition to the existing tenant-scoped policy.
- `organizations`: only organizations with active memberships for the resolved user, in addition to the existing tenant policy.
- `platform_user_roles`: self-read only; platform roles provide no tenant bypass.

Authentication audit rows with no organization are allowed only for `resource='authentication'`; they are not readable through a customer tenant context. Organization and branch selections are recorded as `AUTH_ORGANIZATION_SELECTED` and `AUTH_BRANCH_SELECTED`; stale organization or branch context cleared after a membership/status/assignment change is recorded as `AUTH_ORGANIZATION_CONTEXT_CLEARED` or `AUTH_BRANCH_CONTEXT_CLEARED`. Events record context IDs and fixed reason categories but never session or credential material. Context clearing and its audit row share one transaction. The existing append-only trigger remains active.

## Abuse controls

Login is rate-limited to 5 requests per IP per minute by default. This limit is configurable with `AUTH_LOGIN_RATE_LIMIT_MAX` and `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS`. Ten invalid passwords within a 15-minute account window lock the account for 15 minutes. Invalid credentials, unknown users, and inactive accounts return the same public 401 response. Unknown/inactive cases run a dummy Argon2id verification to reduce timing-based account discovery. Rate-limit errors are distinct (429); malformed input is a 400.

The rate limiter currently uses process memory. Production with multiple API instances must provide a shared rate-limit store or equivalent trusted edge control; this repository has no Redis/edge infrastructure configured yet. Lockout is applied per account and can still be abused for denial of service; pair the current thresholds with monitoring and a recovery procedure before production.

## Events and sensitive data

The existing append-only `audit_logs` captures `AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILURE`, `AUTH_LOGOUT`, `AUTH_SESSION_CREATED`, `AUTH_SESSION_REVOKED`, `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_UNLOCKED`, `AUTH_ORGANIZATION_SELECTED`, `AUTH_BRANCH_SELECTED`, `AUTH_ORGANIZATION_CONTEXT_CLEARED`, and `AUTH_BRANCH_CONTEXT_CLEARED`. Events include request ID, result, fixed reason category, IP, and user agent where available. They exclude entered email addresses, passwords, hashes, and session secrets.

Pino request logs redact password and hash fields, authorization, and cookies. Authentication handlers never log body content or credential material.

## Threat model / limits

| Threat                         | Current mitigation                                                                            | Remaining limitation                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Password database disclosure   | Argon2id hash; no plaintext credential column                                                 | Password reset and credential rotation absent                                             |
| Session database disclosure    | High-entropy random token; digest-only persistence                                            | Database write access can still revoke/create sessions                                    |
| Cookie theft / fixation        | HttpOnly, Secure in production, SameSite, opaque new secret per login, server-side revocation | HTTPS/TLS and client-device protections depend on deployment                              |
| CSRF                           | SameSite=Lax, JSON-only mutations, Fetch Metadata and Origin allowlist                        | Correct production origins and ingress configuration required                             |
| Account enumeration            | Generic credential response and dummy Argon2id verification                                   | Rate-limit response and timing are externally observable                                  |
| Brute force                    | Configurable IP limiter and account lockout                                                   | In-memory limiter is not distributed; lockout can be abused                               |
| Tenant/branch-ID tampering     | Active membership/org/branch/assignment check before context update; forced RLS               | Branch-row filters for future business tables and full RBAC/data scopes remain later work |
| Malicious platform operator    | Separate platform role assignments; no automatic bypass                                       | Audited, time-limited support access is not implemented                                   |
| Credential leakage in logs/API | Safe response allowlist and logger redaction                                                  | New routes must preserve these conventions                                                |

Deferred features include MFA, email verification, password recovery, account invitation/provisioning, account-management authorization, API token auth, support impersonation/access grants, and full organization/branch RBAC. This document describes implemented foundations and explicit limits, not those deferred capabilities.
