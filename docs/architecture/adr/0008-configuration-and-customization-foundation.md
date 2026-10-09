# ADR 0008: Configuration and customization foundation

- **Status:** Accepted
- **Date:** 2026-10-06

The workflow-execution boundary below describes the pre-Phase 18 decision.
Phase 18 adds bounded event-triggered execution code; production worker
availability remains a separate deployment concern. The current capability
flag contract is documented in the [configuration guide](../../configuration/README.md#workflow-and-other-metadata).

## Context

Organizations need different business settings, branding, flags, metadata, and future workflows without customer-specific code forks. The repository already contains tenant-scoped configuration and customization tables, forced RLS, centralized RBAC, module entitlements, append-only audit, and a feature-flag precedence helper.

## Decision

- Reuse organization, branch, identity, RBAC, entitlement, feature, audit, and RLS infrastructure; do not create parallel authorization or tenant systems.
- Keep settings relational when they represent stable business concepts. Use versioned JSONB only for validated flexible preferences.
- Resolve request organization from authenticated session and active membership. Route organization IDs are consistency checks, not trust anchors.
- Keep permission, module entitlement, feature assignment, and configuration as separate decisions. A feature flag cannot grant permission or entitlement.
- Prefer configuration, feature flags, reusable workflow metadata, compatible extensions, and finally reviewed custom development. Do not create client-specific forks.
- Treat custom field and workflow metadata as inert data. No dynamic schema changes or arbitrary code execution.
- Store integration secret references only; provider credentials belong in a future secret manager.

## Consequences

The schema and tenant-authorized APIs support organization/business settings and branding, typed feature flags with branch/module resolution, custom-field definitions, inert versioned workflow metadata, notification preferences, integration metadata, and custom-domain metadata. External provider calls, message dispatch, secret management, DNS/SSL automation, and the full configuration UI remain future work.

### Phase 18 clarification — workflow execution capability

Phase 18 supersedes the earlier consequence that workflow execution remained
future work: bounded, event-triggered workflow runtime code is now implemented
for every supported deployment type. `workflowExecution` in the configuration
capability resolver therefore indicates runtime code support only. It does not
grant `core.configuration` entitlement or workflow-management permission, and
it does not report worker deployment, scheduler health, or production
operational readiness. Existing authenticated tenant context, authorization,
entitlement, transaction, and RLS checks remain independently required.

The handler factory and queued job are not evidence of a running worker or
scheduler. Production workflow execution remains unverified until its
worker/scheduler is configured and operationally tested. This clarification
does not revise this ADR's historical record; it records the later Phase 18
scope and capability contract.

Additive migrations provision the Phase 7 permissions and backfill them to existing system Organization Owner and Organization Admin roles; Manager, Staff, and Viewer receive no configuration-management grants.

All tenant configuration remains protected by forced RLS and verified tenant transactions. Platform administration does not bypass customer RLS or imply access to operational data.
