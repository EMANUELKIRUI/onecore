# Database architecture

OneCore's database technology, schema inventory, migration workflow, role separation, transaction boundary, and exact developer commands are documented in the [database guide](../../database/README.md). The accepted database and ORM decision is [ADR 0002](../architecture/adr/0002-postgresql-drizzle-persistence.md).

## Domain inventory

The Drizzle schema currently defines 61 tables covering:

- organizations, deployment type, lifecycle, branches, users, memberships, branch assignments, organization roles, permissions, and data scopes;
- the platform module/version/dependency/feature/permission catalog, organization module and feature entitlements, and scoped feature flags;
- plans, plan items, subscriptions, history, and organization entitlements;
- structured organization configuration, business settings, branding, tax, numbering, notifications, and storage references;
- custom field definitions and values, versioned workflow definitions and executions, integrations, and custom domains;
- OneCore extensions and deployment metadata, custom-development intake and delivery records, append-only audit logs, and transactional outbox events.

Tenant-scoped entities carry an organization key. Composite foreign keys enforce same-organization membership/role/branch/workflow/custom-field relationships. JSONB is limited to dynamic profile/configuration/snapshot structures; core business relationships and enumerated state remain relational.

## Security and limitation

PostgreSQL RLS is enabled and forced on tenant tables. Tenant queries must run through the transaction-scoped context; the database role must not own the protected tables and must not bypass RLS. This is a persistence isolation boundary, not authentication or authorization. Authentication and bounded workflow execution code exist in their owning packages; this database foundation does not itself provide their application policy or run a production worker. Business modules, external payment integrations, extension runtime, and production deployment provisioning remain outside the implemented database foundation.
