# Feature flags

Feature definitions live in `feature_flags`; assignments live separately in `feature_flag_assignments`. Values are typed as `BOOLEAN`, `STRING`, `NUMBER`, or `JSON`. Scopes are `SYSTEM`, `PLATFORM`, `GLOBAL`, `ENVIRONMENT`, `MODULE`, `ORGANIZATION`, `BRANCH`, and `USER`; checks and composite foreign keys validate scope dimensions and same-tenant branch ownership.

`resolveFeatureFlag` applies user → branch → organization → module → environment → platform/global → system/default precedence. It fails closed without authenticated active organization/membership; module context additionally requires server-loaded entitlement. The API derives branch only from verified session context and resolves module keys through the registered module catalog.

The API reads and mutates typed organization or verified-branch assignments using `core.organization.features.read/update` and append-only audit records. There is no client API for system/platform assignment management. Security-sensitive definitions default false, must be boolean, and cannot be enabled by organization assignments. A flag is not a permission, entitlement, or security boundary. Module-disabled remains disabled even when a product flag is assigned true.

Security controls such as tenant isolation, authentication, authorization, audit, and RLS must not be toggled by organization configuration. New definitions must set a validated type and an explicit safe default; platform/system assignment management remains a trusted administrative operation.
