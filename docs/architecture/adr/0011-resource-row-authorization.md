# ADR 0011: Query-level resource row authorization

- **Status:** Accepted
- **Date:** 2026-10-07

## Problem

The existing authorization service resolved tenant membership, lifecycle,
roles, permissions, module entitlements, and effective scope grants, but
resource services still needed a consistent way to apply those scopes to rows.
Permission approval alone must not grant access to every row in an organization.
No business-domain tables or CRUD routes currently exist, so the decision must
preserve existing platform foundations without inventing domain functionality.

## Decision

Reuse the centralized authorization service and its `ResolvedAuthorizationContext`.
For row-bearing service operations, construct SQL predicates from effective
permission grants and apply those predicates in the read or mutation query:

1. Always constrain rows by the verified organization.
2. `ORGANIZATION` permits rows in that organization.
3. `BRANCH` requires a verified current branch and matches that branch only.
4. `OWN` and `SELF` match the resource's explicitly mapped owner column.
5. `ASSIGNED` matches the explicitly mapped assignee column.
6. For `ASSIGNED` membership branch access, additionally constrain all supported
   scopes to the verified branch.
7. Ignore unsupported scope/resource combinations. If no scope produces a
   predicate, deny access rather than widening the query.

Create operations validate the target organization and applicable branch,
owner, and assignee values before insertion. Client-provided identifiers remain
inputs only; trusted organization, user, and branch context comes from the
existing authenticated authorization flow.

The first mappings are:

| Resource                 | Owner mapping        | Assignee mapping |
| ------------------------ | -------------------- | ---------------- |
| Jobs                     | `created_by_user_id` | None             |
| Stored objects           | `created_by_user_id` | None             |
| Indexed search documents | None                 | None             |

The policy is currently wired to job enqueue/retry/cancel, stored-object
upload/read/list/delete, and indexed-search index/remove/query operations.
Indexed search therefore does not support owner/assignee-only scopes. No
customer, supplier, product, inventory, sales, finance, HR, or other
business-domain routes or tables are added by this decision.

## Database and failure behavior

Keep PostgreSQL tenant RLS enabled and forced as the tenant-isolation boundary.
Application query predicates add permission and row-scope enforcement; they
do not weaken RLS, alter grants, or use `BYPASSRLS`. The existing authorization
transaction continues to enforce active user, session, membership,
organization lifecycle, module entitlement, and permission before resource
queries. Missing authorization context or an unsupported scope produces no
permitted rows and cannot be used to bypass the transaction boundary.

Existing mutation audit and transactional outbox behavior is preserved. No
speculative domain events or duplicate audit tables are introduced.

## Consequences

The existing RBAC and scope catalog remain canonical; no second authorization
system or new permission catalog is introduced. New resources must explicitly
map their tenant, branch, owner, and/or assignee columns before those scopes
can grant access. `DEPARTMENT`, `CUSTOM`, and future domain-specific policies
remain denied until their semantics and query predicates are implemented.
Business-resource authorization is not complete until actual business-domain
resources are implemented and use this boundary.

## Testing

**Phase 12 authorization foundation: COMPLETE.** This status covers the
authorization foundation and only the platform resources listed in this ADR.
Business-domain authorization is deferred until business resources and routes
exist.

Unit tests cover supported and unsupported scope mappings and creation
constraints. PGlite service integration tests verify branch and owner filtering
for jobs under the existing application role and RLS setup. Existing
authorization, lifecycle, API, and persistence tests remain part of validation.

Live PostgreSQL 18.6 validation was completed on 2026-10-07 against a fresh,
isolated database after applying all 29 migrations. Fifteen checks passed using
the non-superuser, `NOBYPASSRLS` `onecore_app` role, including direct RLS
visibility, cross-tenant and cross-branch denial, forged context rejection,
job and storage `OWN` scope, module entitlement, suspended-organization
enforcement, and a branch-scoped storage key within the schema limit. The
throwaway database and local storage fixture were removed afterward. This
validates only the existing platform resources; business-domain authorization
remains deferred until those resources and routes exist. Production managed
PostgreSQL validation remains required before production.
