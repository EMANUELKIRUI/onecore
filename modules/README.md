# Business modules

No business modules are implemented in Phase 1. Each future module should own its domain, application, infrastructure, API, UI, configuration, permissions, workflows, tests, `module.manifest.ts`, and README.

Modules communicate through service contracts and published application/domain events. They must not import another module's internals or access another module's persistence directly. Module entitlement and permission enforcement belongs on trusted server-side service boundaries; UI visibility is not authorization.

See [module architecture](../docs/modules/README.md).
