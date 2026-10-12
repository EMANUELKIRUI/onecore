# API foundation

The service is `services/api`. It requires `DATABASE_URL` for a non-owner, `NOBYPASSRLS` application role. `GET /health` reports process liveness only and does not query dependencies. `GET /ready` checks PostgreSQL connectivity with a bounded read-only query and returns `503` when unavailable; `/health/ready` remains a compatibility alias. API error responses use shared contracts and do not expose internal exception details.

## Authentication routes

| Method | Route                          | Behavior                                                                                                                                                     |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/auth/login`                  | Validates credentials; privileged roles receive `MFA_REQUIRED` without a normal session until MFA is completed.                                              |
| `POST` | `/auth/owner-credential-setup` | Consumes a one-hour, single-use first-Owner invitation and stores an Argon2id password; issues no session and requires sign-in plus mandatory MFA afterward. |
| `POST` | `/auth/mfa/enroll`             | Requires an authenticated user or a privileged user's verified password; starts a ten-minute TOTP enrollment or verifies and enables it.                     |
| `POST` | `/auth/mfa/challenge`          | Re-verifies the password, throttles attempts, atomically consumes a valid TOTP time-step, then issues the normal session.                                    |
| `POST` | `/auth/logout`                 | Revokes the presented session and clears the cookie; safe to call when already anonymous.                                                                    |
| `POST` | `/auth/password/change`        | Requires the current password, changes the Argon2id credential, revokes all of the user's active sessions atomically, and clears the cookie.                 |
| `GET`  | `/auth/session`                | Requires authentication and returns safe user details, selected organization/branch, active memberships, authorized branches, and expiry.                    |
| `POST` | `/auth/organization`           | Requires authentication and an active membership in the requested organization before switching session context.                                             |
| `POST` | `/auth/branch`                 | Requires a selected organization and an active branch assignment or explicit organization-wide branch access.                                                |

Login failures return a generic 401 regardless of whether the account exists or is active. Login is rate-limited by IP. State-changing routes require JSON and validate browser origin. The cookie secret is never included in response JSON. See [authentication security](../security/authentication.md).

The production API injects the shared PostgreSQL login limiter. If it is
missing or the database cannot enforce the limit, login fails closed rather
than falling back to process-local state. Tests and non-production app
instances without an injected limiter use Fastify's process-local limiter.

## Public organization applications

| Method | Route                                                      | Behavior                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/public/organization-applications/modules`                | Lists currently available modules that an applicant may request.                                                                                                                                         |
| `POST` | `/public/organization-applications`                        | Validates and stores a rate-limited organization application in `PENDING`; it does not create an owner identity, login, or workspace access.                                                             |
| `GET`  | `/platform/organization-applications`                      | Lists applications for an authenticated platform superadmin.                                                                                                                                             |
| `POST` | `/platform/organization-applications/:id/status`           | Transitions an application through the platform lifecycle service for an authenticated platform superadmin.                                                                                              |
| `POST` | `/platform/organization-applications/:id/provision`        | For an approved application, atomically enables its requested available modules, activates its organization, and provisions one invited Organization Owner; requires a live platform Superadmin session. |
| `POST` | `/platform/organization-applications/:id/owner-invitation` | Issues a fresh setup token only for the invited Owner of an active application organization and sends it through configured Resend; requires a live platform Superadmin session.                         |

The public POST validates JSON and browser origin and permits at most five
requests per IP per minute using the shared PostgreSQL limiter in production.
Production requests fail closed with `503` if shared limiting is not
configured or cannot run; denied requests return `429`. Tests and
non-production app instances without an injected limiter use Fastify's
process-local limiter. Submission does not itself approve, activate, or
provision an organization. Review and later owner-account setup remain
separate administrator operations. Provisioning remains separate from
credential activation. The Owner invitation requires `MFA_ENCRYPTION_KEY`,
`BUSINESS_APP_ORIGIN`, `RESEND_API_KEY`, and `RESEND_FROM_EMAIL`; it returns
`QUEUED` only when Resend accepts the message, which is not proof of delivery.
Retries revoke prior unconsumed setup tokens and issue a fresh link.

Authentication is not the complete authorization engine. Business Manager currently provides organization-scoped customer and catalog CRUD at `/organizations/:organizationId/business/customers` and `/organizations/:organizationId/business/catalog`. The organization configuration `GET`/`PATCH` routes also expose the authorized business contact and address profile. These routes verify the requested organization against authenticated context and enforce permissions, module entitlements, branch access, and data-scope rules before returning or changing data. Organization and branch IDs are requested context only; the server verifies current membership, organization/branch status, and branch access. Branch selection does not replace RBAC or data-scope checks. Branch-directory CRUD and membership branch assignment routes are documented below. Platform roles do not grant operational access.
The configuration `GET` response includes `permissions.canUpdateSettings` as
an advisory UI flag; the `PATCH` route independently enforces
`core.organization.settings.update`.

Validate every external input at the API boundary. Route handlers should delegate business decisions to application services; domain code must not depend on Fastify.

## Business Manager resources

| Method   | Route                                                           | Behavior                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/organizations/:organizationId/business/customers`             | Returns a tenant- and data-scope-filtered page of customers, with `capabilities.canCreate`, `canUpdate`, and `canDelete` reflecting the current authorization context. These flags guide UI visibility only. |
| `POST`   | `/organizations/:organizationId/business/customers`             | Creates a customer with `core.business_manager.customer.create`; validates fields, organization, branch, and data scope.                                                                                     |
| `GET`    | `/organizations/:organizationId/business/customers/:resourceId` | Returns one customer only when visible in the current organization and data scope.                                                                                                                           |
| `PATCH`  | `/organizations/:organizationId/business/customers/:resourceId` | Updates one in-scope customer with `core.business_manager.customer.update`.                                                                                                                                  |
| `DELETE` | `/organizations/:organizationId/business/customers/:resourceId` | Deactivates an in-scope customer with `core.business_manager.customer.delete`; rows are retained.                                                                                                            |
| `GET`    | `/organizations/:organizationId/business/catalog`               | Returns a tenant- and data-scope-filtered page of products/services, with the equivalent create/update/delete capability flags.                                                                              |
| `POST`   | `/organizations/:organizationId/business/catalog`               | Creates a catalog item with `core.business_manager.catalog.create`; validates fields, organization, branch, and data scope.                                                                                  |
| `GET`    | `/organizations/:organizationId/business/catalog/:resourceId`   | Returns one catalog item only when visible in the current organization and data scope.                                                                                                                       |
| `PATCH`  | `/organizations/:organizationId/business/catalog/:resourceId`   | Updates one in-scope catalog item with `core.business_manager.catalog.update`.                                                                                                                               |
| `DELETE` | `/organizations/:organizationId/business/catalog/:resourceId`   | Deactivates an in-scope catalog item with `core.business_manager.catalog.delete`; rows are retained.                                                                                                         |

All routes also require the `core.business_manager` module entitlement and
active organization access. The list capability flags are advisory only:
every mutation independently checks the relevant permission, branch context,
data scope, and tenant authorization.

## Sales transaction foundation

| Method | Route                                                 | Behavior                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/organizations/:organizationId/sales`                | Creates an unpaid `OPEN` sale from active catalog IDs and positive whole quantities. Requires `Idempotency-Key` and `core.sales.sale.create`. Prices, currency, branch, organization, cashier, and totals are resolved server-side. |
| `GET`  | `/organizations/:organizationId/sales?limit=&offset=` | Lists sale summaries for the verified current branch and effective `core.sales.sale.read` data scope.                                                                                                                               |
| `GET`  | `/organizations/:organizationId/sales/:saleId`        | Returns the sale and immutable transaction-time line snapshots within the current authorized branch and data scope.                                                                                                                 |

Create bodies are strict: `{ "lines": [{ "catalogItemId": "<uuid>",
"quantity": 1 }] }`. There must be 1-100 unique catalog IDs; quantities are
whole numbers from 1 to 1,000,000. No client price, total, discount, tax,
stock, branch, organization, or cashier fields are accepted. `Idempotency-Key`
is printable ASCII, 1-200 characters. A retry with the same organization,
creator, branch, key, and semantic line set returns the original `201` sale. Reusing a
key for another payload or branch returns `409 CONFLICT`; clients must reuse
the original key after uncertain timeouts. Other error classes are `400`
validation/catalog/currency, `401` unauthenticated, `403` unauthorized or
missing branch, and `404` for concealed foreign-tenant resources.

Sales routes require a live session, active organization membership and
organization, verified active branch, the `core.sales` entitlement, and the
permission named above. RLS is forced on `sales` and `sale_lines`. Sale
creation reserves available product stock in the same transaction and rejects
insufficient stock; Inventory also exposes branch stock reads and
receipt/adjustment movements. The only supported sale status is `OPEN`
(unpaid); total currently equals subtotal. The API does not process or confirm
payments, calculate taxes/discounts, finalize sales, or return receipts. The
Business POS calls this contract. See the [Sales module boundary](../modules/sales.md).

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
- `POST /platform/organizations/:organizationId/activate` activates only non-application organizations whose status may transition to `ACTIVE`; application organizations must use the approved application provisioning operation.
- `POST /platform/organization-applications/:id/provision` requires `APPROVED`, provisions the applicant as an invited `PENDING`/`INVITED` Owner without a password or session, enables only the application-requested modules that remain available, and activates the organization in one transaction. Retries return the already-provisioned result; incomplete or inconsistent active application state fails closed.
- `POST /organizations/:organizationId/users` creates an active user and organization membership; it requires `core.organization.user.create` in the verified organization context. The supplied password is Argon2id-hashed and never returned or written to audit/event data.
- `POST /organizations/:organizationId/invitations` creates or reuses an identity and records an `INVITED` membership. It requires `core.organization.user.create` in the verified organization context.

Each successful mutation, its audit record, and its lifecycle outbox event commit in one transaction. A platform SUPERADMIN is never added to a tenant as bootstrap owner; the explicit owner must be a distinct identity. Application provisioning leaves the new Owner invited and unable to sign in until the one-time credential setup token is accepted. Setup activates the pending identity and membership atomically, verifies the invitation email, and does not issue a session. The Owner must then sign in and complete mandatory authenticator-app MFA before normal session issuance. Ordinary invitations still persist pending identity and `INVITED` membership state; no generalized email/SMS delivery or member invitation acceptance flow is configured or claimed.

## Organization member directory

| Method | Route                                                        | Behavior                                                                                                                                                     |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/organizations/:organizationId/members?limit=&offset=`      | Lists bounded pages of organization membership identity and status for callers with the organization-scoped `core.organization.user.read` permission.        |
| `GET`  | `/organizations/:organizationId/members/:membershipId/roles` | Returns assigned and active organization roles plus advisory `capabilities.canAssign`/`canRemove` flags; requires organization-scoped `core.rbac.role.read`. |

The route verifies the organization against the authenticated membership,
records permission checks through centralized authorization, and only reads
member identities after authorization. It returns membership ID, email,
display name, membership status, and membership creation time; it never
returns credentials, user security state, branch assignments, or role grants.
The `users` RLS directory-read policy is enabled only for the verified tenant
and only after the route sets its transaction-local directory context.
The roles route returns role IDs, names, and status only; it does not query or
return user identity records. Its `capabilities.canAssign` and
`capabilities.canRemove` flags are advisory and account for organization-scope
grants and self-target restrictions. Role assignment and removal use the existing
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

| Method   | Route                                                                     | Request                                  | Response                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/organizations/:organizationId/members/:membershipId/branches`           | No body.                                 | `200 { membershipId, branchAccessMode, explicitAssignments, availableBranches, effectiveAccess: { mode, branches }, capabilities: { canAssign, canRemove } }`; explicit assignments include inactive branches; available/effective branches include active branches only. Capability values guide UI visibility; mutation routes independently authorize each request. |
| `POST`   | `/organizations/:organizationId/members/:membershipId/branches`           | `{ branchIds: [uuid, ...] }`, 1–100 IDs. | `200 { membershipId, assignedBranchIds, addedBranchIds }`; repeated IDs and repeated requests are idempotent.                                                                                                                                                                                                                                                          |
| `DELETE` | `/organizations/:organizationId/members/:membershipId/branches/:branchId` | No body.                                 | `200 { membershipId, branchId, removed: true }`; a missing assignment returns a generic `404`.                                                                                                                                                                                                                                                                         |

The routes require the separate organization-scoped permissions
`core.organization.membership_branch.read`,
`core.organization.membership_branch.assign`, and
`core.organization.membership_branch.remove`. Mutations require an active
target membership and active same-organization branches, reject self-targets,
and lock the target membership for the transaction. Explicit assignment
mutations return `409` while `branchAccessMode` is `ALL`; mode transitions are
not exposed. Permission decisions, self-target denials, and successful
changes are recorded in the tenant audit log in the same transaction.
The read response includes active organization branches for assignment choices
and booleans reflecting organization-scoped assign/remove grants. Responses
contain branch metadata only and never return membership identity details.
Capability values are false for self-targeted memberships and `ALL` mode; they
are usability hints only and do not replace authorization in mutation routes.
