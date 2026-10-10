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

Authentication is not the complete authorization engine. Business routes must validate membership, permission, module entitlement where applicable, branch-row access, and data scope before returning or mutating tenant data. Organization and branch IDs are requested context only; the server verifies current membership, organization/branch status, and branch access. Branch selection does not replace RBAC or data-scope checks. Platform roles do not grant operational access.

## Branch management

| Method  | Route                                                    | Permission                        | Behavior                                                                                                                                                     |
| ------- | -------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`   | `/organizations/:organizationId/branches?limit=&offset=` | `core.organization.branch.read`   | Lists tenant branches in name/code order and returns `items`, `total`, `limit`, `offset`, and the caller's `create`/`update` capabilities.                   |
| `POST`  | `/organizations/:organizationId/branches`                | `core.organization.branch.create` | Creates an active branch from `name`, `code`, and optional string `address`. Duplicate codes return `409`.                                                   |
| `PATCH` | `/organizations/:organizationId/branches/:branchId`      | `core.organization.branch.update` | Updates name, code, address, or active status. `INACTIVE` soft-deactivates and `ACTIVE` reactivates; suspended/closed lifecycle transitions are not exposed. |

All routes require active organization membership and an organization-scoped permission grant. Route organization IDs are consistency checks, and branch rows remain protected by forced tenant RLS. List capability flags control frontend affordances only; each mutation independently checks its permission.

## Membership branch assignments

| Method   | Route                                                                     | Permission                      | Behavior                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/organizations/:organizationId/members/:membershipId/branches`           | `core.organization.user.read`   | Returns `membershipId`, `branchAccessMode`, and explicit `assignedBranches` containing only branch ID, name, code, and status. No user identity fields are returned. |
| `POST`   | `/organizations/:organizationId/members/:membershipId/branches`           | `core.organization.user.update` | Accepts `{ "branchIds": ["<uuid>"] }`; atomically assigns one or more active branches to an active `ASSIGNED` membership. Repeated assignments are idempotent.       |
| `DELETE` | `/organizations/:organizationId/members/:membershipId/branches/:branchId` | `core.organization.user.update` | Removes one explicit membership-branch assignment and returns `{ "removed": true, "membershipId": "...", "branchId": "..." }`.                                       |

These routes require organization-scoped permission grants and verify the target membership and branches within the authenticated organization. Cross-organization targets return `404`; self-assignment is denied and audited. Assigning or unassigning while `branchAccessMode` is `ALL` returns `409` rather than silently changing effective access. `ALL` continues to grant all active branches; this API does not mutate the access mode. Each successful assignment or removal is audited in the same transaction. Existing forced RLS on `organization_memberships`, `membership_branches`, and `branches` remains in force; the API returns no user identity data.

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
