# ADR 0008: Configuration and customization foundation

- **Status:** Accepted
- **Date:** 2026-10-06

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

The schema and tenant-authorized APIs support organization/business settings and branding, typed feature flags with branch/module resolution, custom-field definitions, inert versioned workflow metadata, notification preferences, integration metadata, and custom-domain metadata. External provider calls, message dispatch, secret management, DNS/SSL automation, workflow execution, and the full configuration UI remain future work.

Additive migrations provision the Phase 7 permissions and backfill them to existing system Organization Owner and Organization Admin roles; Manager, Staff, and Viewer receive no configuration-management grants.

All tenant configuration remains protected by forced RLS and verified tenant transactions. Platform administration does not bypass customer RLS or imply access to operational data.
