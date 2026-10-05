# ADR 0002: PostgreSQL, Drizzle, and tenant-scoped persistence

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

OneCore needs transactional relational persistence for organization membership, roles and permissions, module entitlements, subscription state, configuration, workflows, audit history, and future financial and inventory records. The Phase 1 ADR deferred the engine and migration decision. The Phase 1 workspace already contains a PostgreSQL Drizzle configuration and the `postgres` driver, so Phase 2 formalizes that direction rather than replacing it.

## Decisions

- Use PostgreSQL 16 or newer as the production relational database. It provides transactions, foreign keys, check and unique constraints, partial indexes, row-level security, and JSONB for selected dynamic data. PostgreSQL 15+ is required for `UNIQUE NULLS NOT DISTINCT`; the supported baseline is 16.
- Use the matching Drizzle ORM and Drizzle Kit `1.0.0-rc.5-5935859` releases with the `postgres` driver for typed schema/query definitions and reviewed SQL migrations. The previous stable Kit line pulled the vulnerable, deprecated `@esbuild-kit/esm-loader`/esbuild chain; the matching RC removes that chain and passes `npm audit --audit-level=moderate`. Pin both packages together and re-evaluate for a supported stable release before production. Database access remains in `@onecore/database`; applications and business modules use trusted services and repositories, not direct database connections.
- Store organization-scoped records with explicit `organization_id`, enable and force RLS, and set `app.current_organization_id` with transaction-local `set_config` only after trusted membership resolution. Use composite foreign keys to keep related roles, branches, workflow versions, and other scoped records in the same organization.
- Run application connections as a non-owner, `NOSUPERUSER`, `NOBYPASSRLS` role with only the grants required by the service. Run migrations with a separate schema owner; that role needs database `CREATE` for Drizzle's migration-metadata schema as well as schema creation rights. The context helper's `FOR SHARE` locks require narrow column-level `UPDATE` privileges on timestamp columns, not table-level update privileges. A missing tenant context returns no tenant rows and rejects tenant writes.
- Keep identity users global and associate them with organizations using `organization_memberships`; do not store password, session, OAuth, or MFA behavior in this phase.
- Use relational columns/tables for business settings, branding, tax, numbering, module and feature entitlements, memberships, and workflow structure. Use JSONB for extensible profile, address, configuration, workflow payload, and audit snapshots—not as a substitute for core relationships.
- Keep domain changes and outbox records in the same transaction. Outbox delivery, retries, and consumers are deferred.
- Use PGlite for fast PostgreSQL-compatible clean-migration and persistence integration tests. Live migrations and RLS/role checks were validated against PostgreSQL 18.6 on 2026-10-05; deployment verification must still run against the provisioned managed PostgreSQL service.

## Alternatives considered

- **MySQL/MariaDB:** mature relational options, but PostgreSQL's row-level security, partial indexes, and JSONB are a closer fit for the tenant boundary and configuration requirements.
- **MongoDB or other document-first storage:** not selected because the core data is relational and requires composite constraints, transactional consistency, and reporting joins.
- **Prisma:** viable typed ORM, but switching from the existing Drizzle configuration would add migration churn without a demonstrated capability gap.
- **Kysely or handwritten SQL only:** viable typed data access, but would require selecting or building a separate migration/schema system. Drizzle already supplies both.

## Migration and transaction strategy

Schema source is `database/schema/`; SQL migrations are generated into `database/migrations/`, reviewed, and committed. Production never relies on schema push or manual edits. Changes follow expand → migrate → verify → contract. Applied migrations are immutable; recover with a forward/compensating migration or a verified backup restore, not an assumed automatic down migration.

Transactions use Drizzle's transaction boundary. The Phase 4 `withActiveOrganizationTransaction` and `withActiveBranchTransaction` helpers validate the user, current membership, operational organization, and optional branch authorization before setting transaction-local RLS context. The lower-level `withOrganizationTransaction` is no longer exported from the package and is restricted to trusted seed/provisioning use. A domain mutation and its `outbox_events` insert must share the same transaction.

## Consequences

- RLS is a second server-side tenant boundary, not a substitute for identity, membership, branch scope, permissions, module entitlement, or service authorization.
- The tenant GUC is trusted application context. Never pass a frontend-supplied organization ID directly to it, and never expose arbitrary SQL on an application connection.
- Platform-wide tables (for example module definitions and permission catalogs) are not tenant rows. Access to them remains limited by database grants and trusted service boundaries.
- RLS policies and append-only audit triggers are currently maintained in reviewed SQL migrations in addition to the Drizzle schema; changing them requires explicit migration review and integration tests.
- PGlite tests and a live PostgreSQL 18.6 run validate migration and policy behavior but do not replace backup/restore, load, extension, or managed-PostgreSQL compatibility testing.
- Drizzle 1.0 is a release candidate, so its exact version pair is pinned and requires an explicit upgrade/compatibility review before production. Keep the schema and migration tests as upgrade gates; do not independently upgrade one of the two Drizzle packages.

## References

- [Database implementation and developer commands](../../../database/README.md)
- [Multi-tenancy model](../../multi-tenancy/README.md)
- [Security foundation](../../security/README.md)
