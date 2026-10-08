# Multi-tenancy foundation

## Organization model

An organization is the tenant root, with a strong lifecycle enum and a first-class deployment type: `SAAS`, `CUSTOM`, `DEDICATED`, or `ENTERPRISE`. Branches, memberships, roles, configuration, entitlements, subscriptions, workflows, integrations, domains, extensions, custom-development records, and audit history carry explicit tenant ownership where applicable.

Users are global identity records and can join multiple organizations through `organization_memberships`. Phase 3 adds authentication credentials and server-side sessions without creating a second identity table. Memberships connect to organization-scoped roles, permission links, branch access, and one or more typed data scopes (`ORGANIZATION`, `BRANCH`, `DEPARTMENT`, `SELF`, `CUSTOM`).

## Isolation path

Request handling resolves the user and active organization through authentication and membership checks, then validates requested branch context before accessing tenant data. Phase 5 centrally resolves organization roles, permissions, and data-scope grants; Phase 6 additionally requires an available, plan-compatible, enabled module entitlement before its permissions are effective. Phase 12 applies query-level organization/branch/owner/assignee predicates to existing job, stored-object, and indexed-search service operations. `OWN`/`SELF` maps to the creator column for jobs and stored objects; resources without an applicable owner/assignee column fail closed. `DEPARTMENT` and `CUSTOM` row policies and all business-domain row authorization remain deferred. Client-supplied organization/branch/role/module/scope values are not trusted.

The database adds a second boundary:

1. Organization and branch context are set with PostgreSQL transaction-local `set_config(..., true)` only after an active membership and requested branch access have been verified.
2. `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` policies filter/guard tenant reads and writes.
3. Application SQL runs with a non-owner, `NOBYPASSRLS` principal.
4. Tenant tables also require explicit organization-scoped repository methods and predicates; RLS is defense in depth, not permission to write unrestricted queries.
5. Composite foreign keys prevent child/association records from linking to another tenant's branch, membership, role, workflow version, or custom-field definition.

Without tenant context, tenant rows are invisible and tenant writes fail. Never set the tenant context directly from an API parameter/header before trusted membership resolution. An app process that can issue arbitrary SQL can change its custom GUC; therefore authorization and process/database credential boundaries remain essential.

## Branch scope

Branches are organization-owned and use the typed lifecycle `ACTIVE`, `INACTIVE`, `SUSPENDED`, or `CLOSED`. Membership branch access defaults to `ASSIGNED` and can include multiple `membership_branches` assignments; trusted organization-wide membership access uses the explicit `ALL` mode. The server persists branch context in the existing session only after verifying the active organization, membership, branch, and assignment. Organization switching clears branch context. This selects a branch but is not complete branch-level data authorization: future branch-bearing business tables must include both organization and branch identity, use a composite `(organization_id, branch_id)` foreign key, apply branch predicates/RLS where appropriate, and query through authorized membership scope.

Phase 18 workflow executions and action-progress records remain owned by the
source event's organization. Executions retain the event's verified branch
when present, use same-organization foreign keys, and cannot be read outside
the caller's effective workflow data scope. Branch-scoped queries require the
verified branch ID; a tenant ID in the route is only checked against the live
membership context. `workflow_execution_actions` has forced RLS and does not
store event payloads or rendered notification content.

## Operational roles

Migrations use a schema owner separate from runtime. Application roles must neither own tenant tables nor hold `BYPASSRLS`/superuser privileges. Platform-wide catalogs (module/permission definitions) and identity user records are not tenant-owned; access must remain limited by service/database grants. See the [database guide](../../database/README.md) and [security documentation](../security/README.md).

## Test coverage and boundary

PGlite integration tests apply migrations to a clean database and explicitly switch into a non-bypass role. They verify missing-context denial, cross-tenant read/write isolation, forced RLS on organization-scoped tables, same-tenant relationships, branch assignment/session constraints, and concurrent transaction-local context. This does not implement complete RBAC decisions, branch-level business-resource policies, or tenant provisioning.
