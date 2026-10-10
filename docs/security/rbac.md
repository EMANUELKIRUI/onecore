# Role-based access control

Authorization is resolved by the API from a live session, active user, active
organization membership, active organization, verified branch context, active
organization roles, role permissions, module entitlement, and effective data
scope. Request-body organization, branch, role, permission, and membership IDs
are lookup targets only; they are never authorization claims. A platform role
does not grant customer-organization permissions or bypass RLS.

## Roles and permissions

Organization roles belong to exactly one organization. Role names are unique
within that organization, and roles have `ACTIVE` or `INACTIVE` status.
Platform roles remain in the separate platform-user-role model. Role
inheritance is not implemented.

Permissions are global catalog entries with a validated canonical key of the
form `module.resource.action`. A role can grant multiple permissions through
the tenant-scoped `role_permissions` relation. A membership can hold multiple
organization roles through `membership_roles`; both relations use composite
organization foreign keys and tenant RLS. Inactive roles and permissions do
not authorize actions.

The baseline role templates (Organization Owner, Organization Admin, Manager,
Staff, and Viewer) are provisioned by the development seed. Authorization does
not branch on role names. Owner authority is represented by a reserved
permission assigned only through trusted provisioning; ordinary RBAC APIs
cannot grant or remove that capability or disable its role. Owner memberships
cannot be assigned roles through the ordinary self-service administration
routes.

## Data and branch scope

Permission grants and membership limits use the existing data-scope enum:
`ORGANIZATION`, `BRANCH`, `OWN`, `ASSIGNED`, and `CUSTOM`, while preserving
legacy `DEPARTMENT` and `SELF` values. Effective grants are the union of active
role permissions, narrowed by membership scope. `CUSTOM` carries validated
non-empty JSON configuration as a future module-specific boundary; business
record filtering for `OWN`, `ASSIGNED`, and `CUSTOM` is not implemented until
those business resources exist.

Branch context is revalidated against the active session, membership,
organization, active branch, and branch assignment before the authorization
service resolves grants. A branch-restricted membership cannot use an
organization-scoped grant to expand its access: it is narrowed to branch
scope. Branch-scoped grants require a verified active branch. Client-supplied
branch IDs are not proof of assignment.

## Context, enforcement, and errors

`createAuthorizationService` is the centralized boundary. It revalidates the
session and tenant membership inside the same transaction as the protected
operation, resolves roles and permissions in batched tenant-scoped queries,
checks module availability and the organization's enabled entitlement, and
returns the effective data scopes. It denies when identity, organization,
membership, branch, role, permission, entitlement, or scope cannot be
validated. No global authorization cache is used.

Unauthenticated requests receive a generic 401. Authenticated requests that
fail authorization receive a generic 403. The frontend is not an
authorization authority. PostgreSQL forced RLS remains the tenant boundary;
authorization never changes database role or bypasses RLS.

The organization administration endpoints currently include `GET /roles`,
`GET /roles/:roleId`, `POST /roles`, `PATCH /roles/:roleId`, `GET /permissions`,
`POST /roles/:roleId/permissions`,
`DELETE /roles/:roleId/permissions/:permissionId`,
`GET /organizations/:organizationId/members/:membershipId/roles`,
`POST /auth/membership/roles`, and
`DELETE /auth/membership/roles/:membershipId/:roleId`. Each is protected by a
catalogued administration permission. Actors cannot assign themselves roles,
assign role permissions they do not hold at the requested scope, grant the
reserved owner capability, or modify a role they themselves hold. Assignment
targets are resolved within the authenticated organization; target memberships
must be active. Role assignment reads membership records only and does not
expand the users identity-read policy.
Role-definition and assignment mutations require organization-scoped
administration permissions. A branch-scoped manager may read the role catalog
within an authorized branch but cannot alter organization-level role
definitions or assignments.

Branch administration uses three additional canonical permissions:
`core.organization.branch.read`, `core.organization.branch.create`, and
`core.organization.branch.update`. They are required by the organization
branch list, create, and update routes, and every operation additionally
requires an organization-scoped grant. The update permission covers `ACTIVE`
and `INACTIVE` soft-status transitions as well as name/code changes; branch
rows remain protected by the existing forced tenant RLS policy. No permission
for `branchAccessMode` changes is introduced in this slice. Membership branch
assignment uses the separate organization-scoped
`core.organization.membership_branch.read`,
`core.organization.membership_branch.assign`, and
`core.organization.membership_branch.remove` permissions. Read authority does
not imply mutation authority. Assignment changes require an active target,
reject self-targeting, and are unavailable while the target uses `ALL` branch
access; all changes and denied self-target attempts are audited transactionally.

Workflow execution history uses the existing
`core.organization.workflows.read` permission and `core.configuration`
entitlement, with a server-side resource-scope predicate on the persisted
execution branch. Workflow scheduling requires
`core.organization.workflows.manage`; notification actions additionally
revalidate `core.organization.notification_inbox.manage` against the live
dispatch principal before creating an in-app notification. Stored session IDs
are identifiers only, not credentials; revoked or expired sessions cannot
authorize an action. UI navigation and route visibility do not grant access.

## Audit and future boundaries

Permission decisions, prevented privilege escalation, and RBAC mutations use
the existing append-only audit log. Metadata contains request ID, branch,
safe target identifiers, and fixed reason categories; it excludes
credentials, session secrets, and request bodies.

Permission resolution requires an available module and an `ENABLED`
organization entitlement using the existing module/entitlement foundation.
This is the integration seam, not a complete module registry or entitlement
lifecycle. Resource-level query predicates now apply supported data scopes to
existing job, storage, and indexed-search service operations. Jobs and stored
objects map owner scope to `created_by_user_id`; search documents have no owner
field, so owner/assignee-only access is denied. No business-domain tables or
CRUD routes are currently implemented, and this work does not claim complete
business-resource authorization. Controlled, time-limited support access
remains deferred. Superadmin support access must later be explicitly
authorized, tenant-bound, time-limited, and audited; it must never bypass RLS.
