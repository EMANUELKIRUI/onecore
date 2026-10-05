# Module registry and entitlement security

Module visibility is descriptive only. A protected server operation must
resolve a registered module, its current lifecycle, the organization
entitlement, active subscription/plan compatibility, dependencies, and the
requesting user's Phase 5 permission before executing.

## Registry and manifest

The registry reuses `modules`, `module_versions`, `module_dependencies`,
`module_permissions`, and `features`. A manifest validates a canonical module
key, semantic version, display name, dependencies with optional minimum
versions, canonical permission keys, feature keys, lifecycle, and optional
configuration/metadata. The stored identity and version must match their
manifest. Unknown permissions/dependencies and dependency cycles are rejected.

Lifecycle transitions are sequential. New registrations begin in
`DEVELOPMENT`; only `AVAILABLE` can be requested or enabled for organizations.
`DEPRECATED` and `RETIRED` do not authorize new access. Platform registry
registration and lifecycle changes require a live session, active account,
platform `SUPERADMIN`, and the trusted registry database connection. The
`onecore_app` role has no catalog write grants. There is no public endpoint
that can change global module lifecycle.

## Organization entitlement

The existing tenant-scoped `organization_modules` relation represents
`REQUESTED`, `PENDING`, `APPROVED`, `AVAILABLE`, `ENABLED`, `DISABLED`,
`SUSPENDED`, and `EXPIRED` state. `POST .../request`, `.../enable`, and
`.../disable` are server-side APIs guarded by `core.modules` permissions.
Organization IDs in the route must exactly match the active authenticated
organization. The endpoint never uses a client-selected organization as
authorization context.

Enabling requires module lifecycle `AVAILABLE`, an active compatible
subscription whose current plan includes that module (or a direct module
subscription item), and every dependency to be independently available,
entitled, enabled, plan-compatible, and at its minimum version. The API
rejects enabling suspended or pending entitlements. Disabling is rejected if
an enabled module directly depends on the target. All organization changes
run under the verified tenant transaction and are audited.

The central Phase 5 authorization resolver uses the same entitlement resolver.
It combines module lifecycle, organization status, active subscription/plan,
module version, and transitive dependencies before it includes a permission
in the effective authorization context. Thus a permission grant alone cannot
authorize an operation when the module is unavailable, disabled, unentitled,
or has a disabled dependency. No superadmin role bypasses organization
membership, permission resolution, or RLS.

## Database and audit boundaries

Organization entitlement rows retain existing forced RLS and composite
organization constraints. Global catalog tables are readable by
`onecore_app`, but registry writes require the separate migration/provisioning
connection. The runtime role receives only `SELECT, INSERT, UPDATE` on
`organization_modules`; it cannot delete entitlement history or mutate the
global catalog.

Tenant entitlement events, dependency rejections, and module authorization
grants/denials use the append-only audit log inside the same tenant
transaction. Global `MODULE_REGISTERED` and `MODULE_LIFECYCLE_CHANGED` events
have no organization ID and are insertable only by `onecore_migrator` for the
`module_registry` resource. Audit metadata contains safe module/version and
transition facts only; it never contains session secrets or credentials.

Plan/subscription management, billing, approval workflows, support access,
business modules, and custom configuration execution remain deferred.
