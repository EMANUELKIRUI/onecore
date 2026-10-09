# API foundation

The service is `services/api`. It requires `DATABASE_URL` for a non-owner, `NOBYPASSRLS` application role. `GET /health` reports process liveness only and does not query dependencies. `GET /ready` checks PostgreSQL connectivity with a bounded read-only query and returns `503` when unavailable; `/health/ready` remains a compatibility alias. API error responses use shared contracts and do not expose internal exception details.

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

The production API injects the shared PostgreSQL login limiter. If it is
missing or the database cannot enforce the limit, login fails closed rather
than falling back to process-local state. Tests and non-production app
instances without an injected limiter use Fastify's process-local limiter.

## Public organization applications

| Method | Route                                            | Behavior                                                                                                                                     |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/public/organization-applications/modules`      | Lists currently available modules that an applicant may request.                                                                             |
| `POST` | `/public/organization-applications`              | Validates and stores a rate-limited organization application in `PENDING`; it does not create an owner identity, login, or workspace access. |
| `GET`  | `/platform/organization-applications`            | Lists applications for an authenticated platform superadmin.                                                                                 |
| `POST` | `/platform/organization-applications/:id/status` | Transitions an application through the platform lifecycle service for an authenticated platform superadmin.                                  |

The public POST validates JSON and browser origin and permits at most five
requests per IP per minute using the shared PostgreSQL limiter in production.
Production requests fail closed with `503` if shared limiting is not
configured or cannot run; denied requests return `429`. Tests and
non-production app instances without an injected limiter use Fastify's
process-local limiter. Submission does not itself approve, activate, or
provision an organization. Review and later owner-account setup remain
separate administrator operations.

Authentication is not the complete authorization engine. Business Manager currently provides organization-scoped customer and catalog CRUD at `/organizations/:organizationId/business/customers` and `/organizations/:organizationId/business/catalog`. The organization configuration `GET`/`PATCH` routes also expose the authorized business contact and address profile. These routes verify the requested organization against authenticated context and enforce permissions, module entitlements, branch access, and data-scope rules before returning or changing data. Organization and branch IDs are requested context only; the server verifies current membership, organization/branch status, and branch access. Branch selection does not replace RBAC or data-scope checks. Branch-directory CRUD is not exposed. Platform roles do not grant operational access.

Validate every external input at the API boundary. Route handlers should delegate business decisions to application services; domain code must not depend on Fastify.

## Workflow execution history

| Method | Route                                                               | Behavior                                                                                                        |
| ------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/organizations/:organizationId/workflow-executions?limit=&offset=` | Lists recent execution status and safe action status for the verified tenant and effective workflow read scope. |
| `GET`  | `/organizations/:organizationId/workflow-executions/:executionId`   | Returns safe status for one execution only if it is visible in the caller's organization/branch data scope.     |

Both routes require `core.organization.workflows.read`, an active
`core.configuration` entitlement, a live session, active organization
membership, and valid branch context. Route organization IDs are consistency
checks, not tenant selectors. Responses omit triggering payloads, resource
identifiers, notification content, recipient identifiers, job payloads, secret
references, and internal authorization details. The business app uses the
list route for its localized status surface; backend checks remain
authoritative.

## Production lifecycle mutations

- `POST /platform/organizations` creates an organization in `PENDING`, provisions the existing default role templates, and creates or resolves the explicitly supplied bootstrap owner as an active identity with an `ACTIVE` membership and the existing Organization Owner role; email is required. A new identity also requires display name and password, which is Argon2id-hashed; an existing active identity is reused without changing credentials. A live platform `SUPERADMIN` session is required.
- `POST /platform/organizations/:organizationId/activate` activates only a status that may transition to `ACTIVE`; a live platform `SUPERADMIN` session is required.
- `POST /organizations/:organizationId/users` creates an active user and organization membership; it requires `core.organization.user.create` in the verified organization context. The supplied password is Argon2id-hashed and never returned or written to audit/event data.
- `POST /organizations/:organizationId/invitations` creates or reuses an identity and records an `INVITED` membership. It requires `core.organization.user.create` in the verified organization context.

Each successful mutation, its audit record, and its lifecycle outbox event commit in one transaction. A platform SUPERADMIN is never added to a tenant as bootstrap owner; the explicit owner must be a distinct identity. Ordinary invitations persist pending identity and `INVITED` membership state; no email/SMS delivery or token/acceptance flow is configured or claimed.
