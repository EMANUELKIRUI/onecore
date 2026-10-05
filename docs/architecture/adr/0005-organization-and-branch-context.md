# ADR 0005: Membership-verified organization and branch context

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Phase 2 established organization-owned branches, active organization memberships, branch assignments, composite same-tenant foreign keys, transaction-local organization context, and forced RLS. Phase 3 added an authenticated server-side session and organization selection. Branch assignments were not yet selectable or represented in session/request context, and branch status used an unconstrained string.

## Decisions

- Reuse `organizations`, `branches`, `organization_memberships`, `membership_branches`, `sessions`, and append-only `audit_logs`. Do not create another identity, membership, tenant-context, or audit system.
- Represent branch lifecycle with the typed `ACTIVE`, `INACTIVE`, `SUSPENDED`, and `CLOSED` enum. Only active organizations and active branches may become operational request context.
- Add `branch_access_mode` to the existing membership. New and migrated memberships default to `ASSIGNED` (fail closed); only explicit branch assignment grants assigned-mode access. `ALL` means organization-wide branch access and must be set only by a trusted membership-administration path.
- Persist the selected branch on the existing server-side session. The composite `(organization_id, branch_id)` foreign key ensures it belongs to that session's selected organization. Changing organization clears branch context in the same transaction.
- Recheck session, active user, active membership, active organization, active branch, and branch assignment server-side. A client organization/branch identifier is only a selection request. Context is populated from trusted database state.
- Set `app.current_organization_id` and `app.current_branch_id` transaction-locally only after the corresponding membership and branch checks. The existing lower-level `withOrganizationTransaction` remains for trusted setup/provisioning only; it is not authentication or authorization.
- Record successful branch selection and stale organization/branch context clearing in the existing append-only audit log. Context mutation and its audit event share a transaction. Record context IDs as event resource identifiers; never record session secrets or cookie values.
- Preserve tenant-wide RLS and `NOBYPASSRLS` application-role requirements. Future branch-bearing business tables must add same-organization composite foreign keys and enforce their branch predicates/RLS; a selected branch alone does not implement RBAC, permission evaluation, or data scopes.
- Define explicit organization lifecycle transitions in core-domain values. No organization lifecycle administration API or billing policy is introduced in this phase; organizations outside `ACTIVE` cannot be selected as normal tenant context.

## Alternatives considered

- **Treat an organization membership as automatic access to every branch:** rejected because branch access must be narrower than tenant membership by default.
- **Add a second branch-membership model:** rejected because `membership_branches` already represents organization-scoped assignments with composite foreign keys.
- **Trust client branch IDs for request filtering:** rejected because it would make frontend state an authorization source.
- **Add branch RLS to all current tenant tables:** rejected because current platform persistence tables are organization-scoped and no operational branch-owned business records exist yet. Branch filters and policies must be introduced with those resource schemas rather than falsely claiming branch-level row isolation now.
- **Give platform administrators implicit tenant access:** rejected; no platform role bypass or support impersonation was added.

## Consequences

- Branch access defaults to no branch unless an explicit assignment exists; trusted organization-wide access must be modeled deliberately.
- Existing active memberships migrate to `ASSIGNED`; a deployment must review branch assignments before relying on branch selection.
- Expired/revoked sessions remain invalid. Membership deactivation, organization suspension, branch closure, or branch-assignment removal invalidates the corresponding saved context on the next request.
- The API exposes organization and branch selection endpoints but no membership/branch administration interface.
- PGlite tests and live PostgreSQL 18.6 validation cover migrations, forced RLS, role attributes, same-tenant constraints, concurrency isolation, and context selection rules. Verification against the production managed PostgreSQL service remains required.

## References

- [Database implementation](../../../database/README.md)
- [Multi-tenancy model](../../multi-tenancy/README.md)
- [Authentication security](../../security/authentication.md)
- [ADR 0002: PostgreSQL and Drizzle](0002-postgresql-drizzle-persistence.md)
- [ADR 0004: Opaque authentication sessions](0004-opaque-server-side-authentication-sessions.md)
