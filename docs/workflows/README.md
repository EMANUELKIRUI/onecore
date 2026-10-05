# Workflow foundation

Organizations own `workflow_definitions`; each definition has numbered `workflow_versions` with `DRAFT`, `PUBLISHED`, or `RETIRED` lifecycle. Steps, transitions, triggers, actions, conditions, and executions are organization-scoped. Composite foreign keys ensure transitions stay within a workflow version, and a partial unique index permits at most one published version per organization/workflow. Publish a replacement only after retiring the current published version.

Workflow structure/configuration is data, not customer-specific source code. Dynamic workflow conditions and actions must be validated against allowlisted operators/action contracts by a future application service. Never evaluate arbitrary SQL, JavaScript, or expressions from organization configuration. The schema does not execute a workflow, implement visual editing, or provide privilege checks. Execution must later re-check permissions and entitlements at every protected action.

Database-backed workflow changes and their audit/outbox records belong in the same transaction. Version edits should create a new version rather than mutate an already published definition in place. Tenant isolation uses the same RLS and explicit organization context described in [multi-tenancy](../multi-tenancy/README.md).
