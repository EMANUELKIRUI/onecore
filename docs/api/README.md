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

## Organization member directory

| Method | Route                                                        | Behavior                                                                                                                                              |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/organizations/:organizationId/members?limit=&offset=`      | Lists bounded pages of organization membership identity and status for callers with the organization-scoped `core.organization.user.read` permission. |
| `GET`  | `/organizations/:organizationId/members/:membershipId/roles` | Returns assigned and active organization roles for that membership; requires organization-scoped `core.rbac.role.read`.                               |

The route verifies the organization against the authenticated membership,
records permission checks through centralized authorization, and only reads
member identities after authorization. It returns membership ID, email,
display name, membership status, and membership creation time; it never
returns credentials, user security state, branch assignments, or role grants.
The `users` RLS directory-read policy is enabled only for the verified tenant
and only after the route sets its transaction-local directory context.
The roles route returns role IDs, names, and status only; it does not query or
return user identity records. Role assignment and removal use the existing
`POST /auth/membership/roles` and
`DELETE /auth/membership/roles/:membershipId/:roleId` routes, requiring
`core.rbac.membership_role.assign` and
`core.rbac.membership_role.remove` respectively. Those mutations remain
organization-scoped, audited, and transactional with their role-change event;
they reject self-assignment/removal, cross-tenant targets, and owner capability
changes. Assignment requires an active organization membership. Forced RLS
limits role and membership queries to the verified tenant.

## Branch administration

The first branch-administration slice reuses the existing `branches` table and
forced tenant RLS policy. Its explicit permission contract is:

- `core.organization.branch.read` for paginated organization branch listings.
- `core.organization.branch.create` for branch creation.
- `core.organization.branch.update` for branch detail updates and
  `ACTIVE`/`INACTIVE` transitions.

Every route verifies the route organization against the live authenticated
membership and requires the matching permission at organization scope.

| Method  | Route                                                    | Request                                                                                                                                                          | Response                                                                                                                                                                                                                                                                                                                               |
| ------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/organizations/:organizationId/branches?limit=&offset=` | Optional `limit` (1–100, default 50) and `offset` (0–10000, default 0).                                                                                          | `{ branches: [{ id, name, code, status, createdAt, updatedAt }], limit, offset, hasMore, capabilities: { canCreate, canUpdate } }`; includes inactive branches for administrative visibility. Capability values reflect organization-scoped grants and only guide UI visibility; mutation routes independently authorize each request. |
| `POST`  | `/organizations/:organizationId/branches`                | `{ name, code }`; name is trimmed and required (max 200 characters), code is trimmed, uppercased, and restricted to 1–50 ASCII letters/digits/underscore/hyphen. | `201 { branch: { id, name, code, status, createdAt, updatedAt } }`; new branches use the existing `ACTIVE` default. Duplicate organization codes return `409`.                                                                                                                                                                         |
| `PATCH` | `/organizations/:organizationId/branches/:branchId`      | A non-empty subset of `{ name, code, status }`; status accepts `ACTIVE` or `INACTIVE`.                                                                           | `200 { branch: { id, name, code, status, createdAt, updatedAt } }`; a branch outside the active tenant returns `404`.                                                                                                                                                                                                                  |

Create and update operations write an append-only audit record in the same
tenant transaction. Deactivation is a soft status change; rows are never
deleted. Reactivation is supported by setting status back to `ACTIVE`.
`SUSPENDED` and `CLOSED` lifecycle transitions, changing `branchAccessMode`,
branch hierarchy, branch-specific configuration, and business transactions
are explicitly outside this slice. The separate membership assignment API
below mutates the existing `membership_branches` relation; branch
administration itself does not.

The forward-only branch-administration migration adds the three permission
catalog entries, grants them to existing system Organization Owner/Admin
roles, and adds only the branch insert/update column privileges needed by the
API. It does not alter branch schema or RLS policy. The `onecore_app` insert
uses only `organization_id`, `name`, and `code`; existing forced RLS continues
to restrict rows to `app.current_organization_id`.

## Membership branch assignments

| Method   | Route                                                                     | Request                                  | Response                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/organizations/:organizationId/members/:membershipId/branches`           | No body.                                 | `200 { membershipId, branchAccessMode, explicitAssignments, effectiveAccess: { mode, branches } }`; explicit assignments include inactive branches, while effective access includes active branches only. `ALL` resolves to every active organization branch. |
| `POST`   | `/organizations/:organizationId/members/:membershipId/branches`           | `{ branchIds: [uuid, ...] }`, 1–100 IDs. | `200 { membershipId, assignedBranchIds, addedBranchIds }`; repeated IDs and repeated requests are idempotent.                                                                                                                                                 |
| `DELETE` | `/organizations/:organizationId/members/:membershipId/branches/:branchId` | No body.                                 | `200 { membershipId, branchId, removed: true }`; a missing assignment returns a generic `404`.                                                                                                                                                                |

The routes require the separate organization-scoped permissions
`core.organization.membership_branch.read`,
`core.organization.membership_branch.assign`, and
`core.organization.membership_branch.remove`. Mutations require an active
target membership and active same-organization branches, reject self-targets,
and lock the target membership for the transaction. Explicit assignment
mutations return `409` while `branchAccessMode` is `ALL`; mode transitions are
not exposed. Permission decisions, self-target denials, and successful
changes are recorded in the tenant audit log in the same transaction.
Responses contain branch metadata only and never return membership identity
details.
