# Configuration security

## Tenant and authorization boundary

The API derives organization context from the authenticated server-side session. Route organization IDs must equal the authorized organization; they never switch tenant context. Settings, feature flags, custom fields, workflows, notifications, integrations, and domains use centralized Phase 5 permissions and verified tenant transactions. Branch overrides derive branch identity from active session context. Tenant tables retain enabled and forced RLS, and missing tenant context returns no tenant rows or denies writes.

Platform roles do not grant a general customer-data bypass. Configuration access does not weaken membership checks, branch authorization, role permissions, module entitlements, or RLS. Platform Superadmin remains subject to tenant RLS and ordinary organization permission checks. Module feature resolution loads entitlement from the server-side registry; the feature API cannot grant it.

## Data safety

Custom field metadata and workflow JSON are inert, bounded, allow-listed data. They are never translated into DDL or executed as SQL, shell, or application code. Integration APIs reject secret-shaped fields, store no plaintext credentials, omit secret references from responses, and sanitize legacy configuration JSON.

Configuration writes use append-only `audit_logs`, recording resource identifiers, changed field names, and safe counts rather than secret values. Integration credentials, secret references, notification recipient content, custom field values, and arbitrary configuration values are not copied into audit records.

## Database operations

The runtime role must remain `NOSUPERUSER NOBYPASSRLS`, must not own protected tables, and must receive only narrow grants. Do not add `GRANT ALL`, weaken policies, or use platform roles as an RLS bypass. Add schema changes through additive migrations and verify forced RLS, tenant isolation, and migration drift against the supported live PostgreSQL instance before claiming live validation.

## Current limitations

External messaging/provider calls, secret-manager integration, domain verification/DNS automation, SSL provisioning, visual workflow design/execution, personal configuration, and business-module custom-field values remain out of scope. `resolveFeatureFlag` is a policy helper and must be called only with context produced by the trusted authorization transaction; its context booleans are not themselves proof of identity or membership.
