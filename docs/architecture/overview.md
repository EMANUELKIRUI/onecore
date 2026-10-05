# Architecture overview

OneCore is organized as a modular monorepo with explicit application, service, shared-package, module, and persistence boundaries. Phase 1 established the engineering foundation. Phase 2 added PostgreSQL/Drizzle domain persistence, organization-aware schema, RLS tenant boundary, and migration/test workflow. Phase 3 adds password authentication, server-side sessions, authenticated request context, organization selection with membership validation, and authentication audit events. Phase 4 adds status-checked organization context, explicit branch access, session-bound branch selection, and tenant integrity tests. Phase 5 adds centralized, server-side organization RBAC and data-scope resolution. Phase 6 adds a validated module registry, lifecycle, dependency and plan checks, organization entitlement APIs, and authorization integration. Business operations, business-row scope policies, controlled support access, and production provisioning remain deferred.

## Dependency direction

```text
Applications ──> Service APIs
     │                │
     └──────> Shared packages <──── Modules
                      ▲                 │
                      └── service APIs ─┘
```

Shared packages must not depend on applications or business modules. A module owns its internals and exposes contracts at its API boundary. Persistence access belongs behind trusted service/infrastructure boundaries. Cross-module workflows use contracts/events rather than direct internal imports.

## Service request boundary

The authorization path is authentication → session → organization membership → organization/branch scope → role/permission → module entitlement → data scope → query → audit. The centralized authorization service resolves those existing foundations and denies absent or inactive permissions, roles, memberships, organizations, branches, and entitlements. Business-row filtering for future `OWN`, `ASSIGNED`, and `CUSTOM` scopes and business APIs remain deferred. `app.current_organization_id` and `app.current_branch_id` are transaction-local trusted server-side context; each is set only after membership and requested scope verification and never from client state directly.

Credentials and sessions are scoped by transaction-local identity GUCs under forced RLS. Login lookup is constrained to the normalized email supplied by the server; session lookup is constrained to the digest of the presented opaque cookie. Authenticated membership discovery is limited to the user ID resolved from a live session. Only trusted API code may set those GUCs. See [ADR 0004](adr/0004-opaque-server-side-authentication-sessions.md).

## Future platform concerns

- Tenant-scoped data access is implemented in PostgreSQL migrations and a transaction-scoped repository boundary; authentication and auditable authorization are prerequisites for business workflows.
- Module manifests declare identity, semantic version, dependencies, permissions, features, lifecycle, and configuration. The registry, organization entitlement APIs, subscription/plan compatibility, and runtime authorization checks are implemented; business modules and the full billing lifecycle remain later work.
- Feature flags will progress through developer, QA, internal, selected-organization, percentage, and general-availability cohorts. Evaluation must be server-side for protected behavior.
- Localization starts with English and Kiswahili, with message keys separated from UI text. Currency values must retain transaction currency, original amount, and the applicable historical exchange-rate facts; never silently recalculate historical transactions at today's rate.
- Domain/application events provide loose coupling for workflows. A transactional outbox persistence foundation exists; event publication, delivery guarantees, retries, and consumers remain deferred.
- AI must use authorized data services after user, permission, and organization-scope checks. Models never receive unrestricted database access.
- PWA/offline behavior is app-specific and must define conflict resolution and secure local-data handling before implementation.

The database/ORM selection is recorded in [ADR 0002](adr/0002-postgresql-drizzle-persistence.md); the configuration/extension boundary is recorded in [ADR 0003](adr/0003-platform-configuration-and-extension-boundary.md); the organization and branch context boundary is recorded in [ADR 0005](adr/0005-organization-and-branch-context.md). No POS, inventory, finance, HR, school, healthcare, hotel, microfinance, or AI business module is included.
