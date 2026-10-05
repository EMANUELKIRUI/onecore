# Module architecture

Each business module is independently structured with `domain/`, `application/`, `infrastructure/`, `api/`, `ui/`, `configuration/`, `permissions/`, `workflows/`, `tests/`, `module.manifest.ts`, and `README.md`.

The manifest contract includes module name, version, dependencies, permissions, features, and configuration. The Phase 2 persistence foundation now stores module/version/dependency/feature/permission definitions separately from module availability and organization-specific `AVAILABLE`/`ENABLED`/`DISABLED`/`SUSPENDED` entitlements. Feature state and user permission remain independent checks. The runtime registry, entitlement service, and business modules are not implemented.

Modules own their domain rules. They integrate through versioned contracts and internal events, not direct access to another module's internals or tables. Server-side entitlement and permission checks are mandatory for every protected operation. No customer-specific module implementations or business-module operations were added in Phase 2.
