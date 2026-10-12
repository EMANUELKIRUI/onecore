# Identity and authentication

## Identity model

The Phase 2 `users` table remains the canonical global identity. It now contains the normalized-login email source, lifecycle status, Argon2id password hash, optional verification timestamp, failed-login window/counter, lock expiry, and last successful login. Membership remains in `organization_memberships`; no second customer-user or account table was added.

Organization roles remain tenant-owned in `roles` and are attached through memberships. Platform roles use the separate `platform_user_roles` table. A platform role is not an organization role, does not grant membership, and does not bypass RLS. The API currently does not implement Superadmin or support authorization.

Mandatory MFA policy is resolved server-side from `platform_user_roles` and
active system Organization Owner/Admin assignments. Request-body flags and
frontend roles are ignored. Role resolution is applied before login can create
a session, again inside the repository session-creation transaction, and when
resolving existing sessions. An old non-MFA session stops resolving if its
identity is later granted a protected role.

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

Protected users receive only an `MFA_REQUIRED` response until TOTP enrollment
or challenge succeeds. First-time enrollment re-verifies the password and
returns a short-lived provisioning URI without issuing a session; the pending
AES-256-GCM-encrypted credential expires after ten minutes. A valid code
enables MFA and may then issue the session. Challenge requests re-verify the
password, use a bounded TOTP window, and atomically consume the accepted
time-step before session creation. Reusing an accepted step is rejected.
Production session creation also checks the authoritative role assignments
inside the database transaction and records whether the session passed MFA.
The MFA credential table is identity-scoped by `app.current_user_id`, not by
organization context.

An authenticated user may change their password with `POST /auth/password/change`, supplying the current password and a new password of at least 12 characters. The endpoint uses the configured authentication rate-limit policy. The API verifies the current credential, hashes the new password with Argon2id, and atomically updates it and revokes all active sessions for that identity. The session cookie is cleared; the user must log in again. A compare-and-set against the previously read hash prevents a stale concurrent credential change from overwriting a newer password. Successful changes and session revocation are recorded together in the existing append-only authentication audit log. A failed current-password check is audited without storing the submitted value.

## First Owner setup

Approved-application provisioning creates the first Owner as a `PENDING` user
with an `INVITED` membership and no password. A Superadmin may request a setup
invitation only for the provisioned Owner; the API verifies the active
Superadmin session and Owner membership/role from PostgreSQL. The API stores a
SHA-256 verifier of a 256-bit random token, bound to that user and organization,
with a one-hour expiry. The raw token exists only long enough to place in the
email's URL fragment and is never returned in API JSON or written to logs.
Resending revokes older unconsumed tokens before issuing another.

`POST /auth/owner-credential-setup` accepts only the token and a password of at
least 12 characters. Under a transaction, it locks the pending identity,
validates and consumes the unexpired token, sets an Argon2id password, verifies
the invitation email, activates the Owner membership, revokes other outstanding
setup tokens and any existing sessions, and records an audit event. Invalid,
expired, revoked, and replayed tokens receive the same public error. The setup
response does not contain a session; the next sign-in receives `MFA_REQUIRED`.
The existing TOTP enrollment flow creates no session until an authenticator
code is verified, after which the resulting session records MFA assurance.
The Owner selects an organization only from the server-returned active
membership list.

The setup page accepts the invitation token from the URL fragment and removes
it from browser history before rendering. It does not persist the token,
password, or MFA secret in browser storage. `BUSINESS_APP_ORIGIN` is a
validated HTTPS origin used to build the link. The invitation route requires
the MFA encryption key and Resend API key/sender configuration; provider
acceptance is reported as `QUEUED`, not delivered. Resending creates a fresh
link, including when the prior provider outcome was uncertain.

Cookies use `Path=/`, `SameSite=Lax`, and `Secure` in production. A common API pre-handler checks Fetch Metadata and the configured origin allowlist for every `POST`, `PUT`, `PATCH`, and `DELETE`; handlers that accept mutation bodies additionally require JSON. `AUTH_ALLOWED_ORIGINS` must list exact browser origins when requests pass through a same-origin proxy. Production ingress must use HTTPS. Do not place sessions in browser localStorage or include them in URLs. Login creates a new random session independent of any caller-provided cookie, preventing fixation.

The API resolves sessions centrally in an `onRequest` hook. Expired, revoked, malformed, or disabled-account sessions are anonymous. `GET /auth/session` returns only safe user identity, selected organization and branch IDs, active memberships, and expiration. `requireAuthenticated()` protects routes; `requireOrganizationMembership()` additionally requires a resolved active organization membership. `POST /auth/organization` switches organization only after both active membership and `ACTIVE` organization status are verified; changing organization clears branch state in the same transaction. `POST /auth/branch` selects a branch only after verifying the saved session organization, active membership, active branch ownership, and branch access mode/assignment. Client-supplied organization and branch IDs are requests, never proof of access.

## Tenant context and RLS

Membership discovery uses a transaction-local authenticated user ID obtained from a live server-resolved session. Organization selection verifies active membership and organization state before updating the existing session. Branch selection verifies branch access and writes the branch GUC only inside the same transaction that updates session context and audit. The middleware rechecks membership and organization state on each request, and rechecks saved branch access before exposing it in request context. Tenant services must use membership-verified context helpers; never copy a request value into `app.current_organization_id` or `app.current_branch_id`.

RLS on identity tables permits:

- `users`: the normalized email currently being checked, or the server-resolved user ID.
- `sessions`: the digest currently being resolved/revoked, or sessions owned by the server-resolved user.
- `organization_memberships`: only the resolved user's memberships, in addition to the existing tenant-scoped policy.
- `organizations`: only organizations with active memberships for the resolved user, in addition to the existing tenant policy.
- `platform_user_roles`: self-read only; platform roles provide no tenant bypass.
- `user_mfa_credentials`: only the server-resolved user ID; organization GUCs
  alone cannot read the encrypted credential.

Authentication audit rows with no organization are allowed only for `resource='authentication'`; they are not readable through a customer tenant context. Organization and branch selections are recorded as `AUTH_ORGANIZATION_SELECTED` and `AUTH_BRANCH_SELECTED`; stale organization or branch context cleared after a membership/status/assignment change is recorded as `AUTH_ORGANIZATION_CONTEXT_CLEARED` or `AUTH_BRANCH_CONTEXT_CLEARED`. Events record context IDs and fixed reason categories but never session or credential material. Context clearing and its audit row share one transaction. The existing append-only trigger remains active.

## Abuse controls

Login, MFA challenge, Owner invitation, and Owner credential setup requests
are rate-limited to 5 requests per IP per minute by default; the shared
production limiter is required for these operations. The limit is
configurable with `AUTH_LOGIN_RATE_LIMIT_MAX` and
`AUTH_LOGIN_RATE_LIMIT_WINDOW_MS`. Ten invalid passwords within a 15-minute
account window lock the account for 15 minutes. Invalid credentials, unknown
users, and inactive accounts return the same public 401 response.
Unknown/inactive cases run a dummy Argon2id verification to reduce timing-based
account discovery. Rate-limit errors are distinct (429); malformed input is a 400.

The API server injects a PostgreSQL-backed limiter for login. API instances that
share that database coordinate limits through atomic counters and forced RLS;
database errors fail closed, and production refuses login if the shared limiter
is not configured. In development and tests, when no database limiter is
injected, the API uses Fastify's process-local limiter; that fallback does not
coordinate across instances. The database limiter is not volumetric edge
protection. Lockout is applied per account and can still be abused for denial
of service; pair the current thresholds with monitoring and a recovery
procedure before production.

## Events and sensitive data

The existing append-only `audit_logs` captures `AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILURE`, `AUTH_LOGOUT`, `AUTH_SESSION_CREATED`, `AUTH_SESSION_REVOKED`, `AUTH_SESSIONS_REVOKED`, `AUTH_PASSWORD_CHANGED`, `AUTH_PASSWORD_CHANGE_FAILURE`, `AUTH_MFA_ENROLLED`, `AUTH_MFA_CHALLENGE_SUCCESS`, `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_UNLOCKED`, `AUTH_ORGANIZATION_SELECTED`, `AUTH_BRANCH_SELECTED`, `AUTH_ORGANIZATION_CONTEXT_CLEARED`, `AUTH_BRANCH_CONTEXT_CLEARED`, `AUTH_OWNER_SETUP_INVITATION_ISSUED`, and `AUTH_OWNER_CREDENTIAL_SETUP_COMPLETED`. Events include request ID, result, fixed reason category, IP, and user agent where available. They exclude entered email addresses, passwords, hashes, invitation tokens, TOTP codes, encrypted secrets, and session secrets.

Pino request logs redact password and hash fields, authorization, and cookies. Authentication handlers never log body content or credential material.

## Threat model / limits

| Threat                         | Current mitigation                                                                                                 | Remaining limitation                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Password database disclosure   | Argon2id hash; no plaintext credential column; authenticated credential rotation revokes sessions                  | Recovery/reset-token workflow and password history are absent                                    |
| Session database disclosure    | High-entropy random token; digest-only persistence                                                                 | Database write access can still revoke/create sessions                                           |
| Cookie theft / fixation        | HttpOnly, Secure in production, SameSite, opaque new secret per login, server-side revocation                      | HTTPS/TLS and client-device protections depend on deployment                                     |
| CSRF                           | SameSite=Lax, JSON-only mutations, Fetch Metadata and Origin allowlist                                             | Correct production origins and ingress configuration required                                    |
| Account enumeration            | Generic credential response and dummy Argon2id verification                                                        | Rate-limit response and timing are externally observable                                         |
| Brute force                    | PostgreSQL-backed shared IP limiter in production and account lockout                                              | No volumetric edge protection; lockout can be abused                                             |
| MFA bypass / replay            | Authoritative protected-role lookup, fail-closed session creation, bounded TOTP window and atomic step consumption | Recovery codes, authorized reset/disable, and deployed production verification remain incomplete |
| Tenant/branch-ID tampering     | Active membership/org/branch/assignment check before context update; forced RLS                                    | Branch-row filters for future business tables and full RBAC/data scopes remain later work        |
| Malicious platform operator    | Separate platform role assignments; no automatic bypass                                                            | Audited, time-limited support access is not implemented                                          |
| Credential leakage in logs/API | Safe response allowlist and logger redaction                                                                       | New routes must preserve these conventions                                                       |

Remaining identity lifecycle work includes recovery codes, authorized MFA
disable/reset, password-reset tokens, and security-notification delivery
through Resend. The first-Owner setup route calls the existing Resend adapter;
email verification is performed by successful first-Owner invitation setup.
Provider success/failure is mocked locally; no real message was sent, and the
sender domain and deployed configuration must be verified with Resend.
Migration behavior and role policy are tested only in disposable local
PostgreSQL-compatible environments; deployment roles and production session
behavior are unverified. Account
invitation/provisioning, account-management authorization, API token auth,
support impersonation/access grants, and full organization/branch RBAC also
remain incomplete. This document describes implemented foundations and
explicit limits, not production readiness.
