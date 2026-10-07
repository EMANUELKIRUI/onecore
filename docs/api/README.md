# API foundation

The service is `services/api`. It requires `DATABASE_URL` for a non-owner, `NOBYPASSRLS` application role. `GET /health` reports process liveness only; it is not a readiness check and does not verify database health or downstream dependencies. API error responses use shared contracts and do not expose internal exception details.

## Authentication routes

| Method | Route                   | Behavior                                                                                                                                     |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/auth/login`           | Validates credentials, creates an opaque server-side session, sets the `HttpOnly` cookie, and returns only safe user/session metadata.       |
| `POST` | `/auth/logout`          | Revokes the presented session and clears the cookie; safe to call when already anonymous.                                                    |
| `POST` | `/auth/password/change` | Requires the current password, changes the Argon2id credential, revokes all of the user's active sessions atomically, and clears the cookie. |
| `GET`  | `/auth/session`         | Requires authentication and returns safe user details, selected organization/branch, active memberships, authorized branches, and expiry.    |
| `POST` | `/auth/organization`    | Requires authentication and an active membership in the requested organization before switching session context.                             |
| `POST` | `/auth/branch`          | Requires a selected organization and an active branch assignment or explicit organization-wide branch access.                                |

Login failures return a generic 401 regardless of whether the account exists or is active. Login is rate-limited by IP. State-changing routes require JSON and validate browser origin. The cookie secret is never included in response JSON. See [authentication security](../security/authentication.md).

Authentication is not the complete authorization engine. There are currently no business-domain CRUD routes. Any such routes must use `requireAuthenticated()` and `requireOrganizationMembership()`, then apply permission, module-entitlement, branch-row, and data-scope checks in the service/query before returning business data. Organization and branch IDs are requested context only; the server verifies current membership, organization/branch status, and branch access. Branch selection does not replace RBAC or data-scope checks. Platform roles do not grant operational access.

Validate every external input at the API boundary. Route handlers should delegate business decisions to application services; domain code must not depend on Fastify.

## Production lifecycle mutations

- `POST /platform/organizations` creates an organization in `PENDING`, provisions the existing default role templates, and creates or resolves the explicitly supplied bootstrap owner as an active identity with an `ACTIVE` membership and the existing Organization Owner role; email is required. A new identity also requires display name and password, which is Argon2id-hashed; an existing active identity is reused without changing credentials. A live platform `SUPERADMIN` session is required.
- `POST /platform/organizations/:organizationId/activate` activates only a status that may transition to `ACTIVE`; a live platform `SUPERADMIN` session is required.
- `POST /organizations/:organizationId/users` creates an active user and organization membership; it requires `core.organization.user.create` in the verified organization context. The supplied password is Argon2id-hashed and never returned or written to audit/event data.
- `POST /organizations/:organizationId/invitations` creates or reuses an identity and records an `INVITED` membership. It requires `core.organization.user.create` in the verified organization context.

Each successful mutation, its audit record, and its lifecycle outbox event commit in one transaction. A platform SUPERADMIN is never added to a tenant as bootstrap owner; the explicit owner must be a distinct identity. Ordinary invitations persist pending identity and `INVITED` membership state; no email/SMS delivery or token/acceptance flow is configured or claimed.
