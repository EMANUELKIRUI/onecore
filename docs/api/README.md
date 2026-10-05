# API foundation

The service is `services/api`. It requires `DATABASE_URL` for a non-owner, `NOBYPASSRLS` application role. `GET /health` reports process liveness only; it is not a readiness check and does not verify database health or downstream dependencies. API error responses use shared contracts and do not expose internal exception details.

## Authentication routes

| Method | Route                | Behavior                                                                                                                                  |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/auth/login`        | Validates credentials, creates an opaque server-side session, sets the `HttpOnly` cookie, and returns only safe user/session metadata.    |
| `POST` | `/auth/logout`       | Revokes the presented session and clears the cookie; safe to call when already anonymous.                                                 |
| `GET`  | `/auth/session`      | Requires authentication and returns safe user details, selected organization/branch, active memberships, authorized branches, and expiry. |
| `POST` | `/auth/organization` | Requires authentication and an active membership in the requested organization before switching session context.                          |
| `POST` | `/auth/branch`       | Requires a selected organization and an active branch assignment or explicit organization-wide branch access.                             |

Login failures return a generic 401 regardless of whether the account exists or is active. Login is rate-limited by IP. State-changing routes require JSON and validate browser origin. The cookie secret is never included in response JSON. See [authentication security](../security/authentication.md).

Authentication is not the complete authorization engine. Protected business routes must use `requireAuthenticated()` and `requireOrganizationMembership()`, then add permission, module-entitlement, branch-row, and data-scope checks before returning business data. Organization and branch IDs are requested context only; the server verifies current membership, organization/branch status, and branch access. Branch selection does not replace RBAC or data-scope checks. Platform roles do not grant operational access.

Validate every external input at the API boundary. Route handlers should delegate business decisions to application services; domain code must not depend on Fastify.
