# ADR 0006: Tenant-scoped RBAC and authorization

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

OneCore requires reusable server-side authorization across future business
modules. Existing organization, membership, session, branch, platform-role,
permission, role, role-permission, membership-role, data-scope, entitlement,
RLS, and append-only audit foundations are canonical and must not be
duplicated. Customer authorization must remain tenant-scoped; platform roles
must not imply operational access or bypass PostgreSQL RLS.

## Decision

- Keep organization roles tenant-owned, with organization-scoped unique names
  and explicit active/inactive state. Keep platform roles separate.
- Keep a global atomic permission catalog with a canonical
  `module.resource.action` key and active/inactive state.
- Resolve multiple membership roles and union their active grants through
  composite organization-scoped join relations.
- Resolve authorization in a centralized transaction service using the live
  session, active user/membership/organization, verified branch, active
  roles/permissions, module entitlement, and effective data scope.
- Narrow organization grants according to membership scope and branch access.
  Never trust client-supplied organization or branch identifiers as proof.
- Use reserved owner capability only through trusted provisioning. Do not
  implement role inheritance or unrestricted support access.
- Reuse forced RLS and append-only audit. Do not use security-definer helpers,
  superuser access, or `BYPASSRLS` to authorize customer operations.
- Protect organization RBAC administration with explicit permissions and
  scope-limited delegation; deny self-assignment and owner-capability changes
  through ordinary APIs. Role-definition and assignment mutations require an
  organization-scoped administrative grant; branch-scoped users cannot mutate
  organization-level role definitions.

## Consequences

Permissions are reusable across organizations while every role grant and
membership assignment is protected by tenant constraints and RLS. Each
authorization operation re-reads the relevant state, avoiding stale global
caches at the cost of several indexed queries. Module entitlement is part of
permission resolution, but the full registry lifecycle is deferred.

`ORGANIZATION`, `BRANCH`, `OWN`, `ASSIGNED`, and `CUSTOM` scopes are represented
now. Record filtering for future business resources, custom policy
interpretation, controlled support access, and administration of owner
transfer are deferred. No business modules are introduced by this decision.

## Validation

The schema migration adds role/permission lifecycle and structured permission
fields plus per-role scope, backfills existing permission keys, and seeds
reusable catalog definitions. It does not recreate RBAC tables or alter the
existing RLS policy model. Migration application and PostgreSQL 18 validation
are tracked with the Phase 5 implementation results.
