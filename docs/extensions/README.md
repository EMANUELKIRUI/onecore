# Controlled extension foundation

Extensions are versioned OneCore platform contracts—not customer forks. The persistence model covers extension definitions and versions, dependencies, declared permissions, organization configuration, and deployment state. Module definitions/versions/features/permissions remain a separate platform catalog; organization module and feature entitlements record availability and enablement separately from user permissions.

Configure before extending. Any custom-development request is recorded with organization, requester, requirements, priority, quote/currency, approvals, project/team, status history, and release. Reviews should first test whether configuration, workflow, feature flag, or an existing extension can meet the need; reusable changes should be delivered through the common platform contract.

This foundation does not load or execute extension code, deploy extensions, provision dedicated infrastructure, or trust extension-provided permissions/configuration. A future runtime requires signed/versioned manifests, permission review, resource limits, isolation/sandboxing, compatibility checks, audit, rollback, and explicit organization enablement. Never store provider credentials in extension configuration; store encrypted secret-manager references in integration/secret infrastructure.
