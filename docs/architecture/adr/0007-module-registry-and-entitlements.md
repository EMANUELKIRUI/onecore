# ADR 0007: Module registry and organization entitlements

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

The Phase 2 schema already contains the global module catalog, version
manifests, dependency edges, module permissions, features, plan-module links,
subscriptions, subscription items, generic organization entitlements, and
organization module state. Phase 5 authorization checked only a catalog
availability boolean and an enabled organization-module row. It did not
validate module lifecycle, subscription compatibility, or dependency state.

## Decision

- Reuse these catalog and entitlement tables. A module key is its canonical
  identity; each version stores a Zod-validated manifest and semantic version.
- Keep an explicit sequential module lifecycle:
  `DEVELOPMENT` → `INTERNAL_TESTING` → `QA` → `SECURITY_REVIEW` → `STAGING` →
  `UAT` → `SUPERADMIN_REVIEW` → `APPROVED` → `AVAILABLE` → `DEPRECATED` →
  `RETIRED`. Only `AVAILABLE` modules can be requested or newly enabled.
- Validate permissions against canonical `module.resource.action` keys,
  dependencies against registered module identities and semantic version
  ranges, and reject dependency cycles.
- Resolve customer module access from the active organization subscription,
  available plan/module links or direct subscription module item, module
  lifecycle, organization module status, and all dependencies. Missing,
  inactive, unavailable, expired, or inconsistent facts deny access.
- Keep module registration and lifecycle changes in a registry service that
  requires a live session and platform `SUPERADMIN` role and a database
  connection with registry-write privileges. The API runtime receives only
  catalog reads; no customer request can edit the global registry.
- Keep organization request, enable, and disable in tenant-context APIs behind
  organization module-management permissions. Organization IDs in routes
  must match the trusted authenticated context. Enabling checks plan and
  dependencies; disabling is rejected while a dependent module is enabled.
- Keep catalog data global and organization-module state protected by existing
  forced RLS. Platform lifecycle audit uses the append-only audit table and a
  narrow migration-role-only insert policy; tenant entitlement events are
  recorded in the tenant audit context.
- Do not grant `SUPERADMIN` access to customer data or a tenant RLS bypass.

## Consequences

Permission checks now require a fully resolved enabled module entitlement,
including the commercial plan boundary and dependency chain. Existing module
availability is backfilled into lifecycle state, and existing module rows
receive a versioned baseline manifest without dropping historical records.
The development seed registers only core platform modules.

Payment processing, entitlement approval workflows, support access, business
modules, UI, and configuration/customization services remain out of scope.
