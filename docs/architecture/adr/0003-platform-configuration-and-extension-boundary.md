# ADR 0003: Configurable organization capabilities and controlled extensions

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

OneCore serves organizations with different industries, deployment arrangements, workflows, plans, and branding. Customer-specific forks would prevent reliable upgrades and make security behavior inconsistent.

## Decision

- Represent the deployment arrangement (`SAAS`, `CUSTOM`, `DEDICATED`, `ENTERPRISE`) as an organization domain value; provisioning and support policy are future services, not scattered deployment-type conditionals.
- Resolve organization differences in this order: platform configuration, organization settings, workflow definitions, feature flags, and compatible OneCore extensions. Custom development requests are recorded and reviewed for a reusable extension or platform capability; they do not create customer branches.
- Keep important settings relational. Store only genuinely dynamic values in versioned JSONB configuration. Keep custom field definitions and values organization-scoped and typed, without changing the core schema per organization.
- Version workflows and extensions; store requirements, approvals, quotes, projects, releases, and audit history for custom development.
- Treat extension manifests and configuration as platform data only. This phase does not run extension code, provide a plugin sandbox, dynamically execute workflow expressions, or provision customer infrastructure.

## Consequences

- Configuration and entitlement data can be tested and audited without creating separate application implementations.
- Runtime validation, safe extension execution/isolation, deployment automation, visual workflow design, and custom-development delivery belong to later phases.
- Organizations may share platform/module definitions while keeping their own entitlement, feature, configuration, workflow, and domain state.

## References

- [Configuration architecture](../../configuration/README.md)
- [Module and entitlement model](../../modules/README.md)
- [Workflow foundation](../../workflows/README.md)
- [Extension architecture](../../extensions/README.md)
