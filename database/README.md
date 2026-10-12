# Database foundation

## Technology

OneCore uses PostgreSQL 16+ with a pinned matching Drizzle ORM/Drizzle Kit 1.0.0 release-candidate pair and the `postgres` Node.js driver. PostgreSQL provides relational constraints and transactions for tenant membership and future financial records, row-level security for the tenant boundary, partial indexes for activation rules, and JSONB for selected dynamic configuration. The database schema is declared in `schema/`; generated and reviewed SQL migrations live in `migrations/`. The RC pair avoids a moderate advisory in the previous stable Kit's deprecated esbuild loader chain; replace it only with a tested, non-vulnerable stable pair.

The persistence choice and alternatives are recorded in [ADR 0002](../docs/architecture/adr/0002-postgresql-drizzle-persistence.md). The organization customization boundary is recorded in [ADR 0003](../docs/architecture/adr/0003-platform-configuration-and-extension-boundary.md).

## Local PostgreSQL setup

Install PostgreSQL 16+ separately, create a development database, and provision a local migration-owner role. Set `DATABASE_URL` in the shell; these CLI commands do not load `.env` automatically. Do not use production credentials for development.

```sh
createdb onecore_dev
export ADMIN_DATABASE_URL='postgresql://postgres:admin-local-password@127.0.0.1:5432/postgres'
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE onecore_migrator LOGIN PASSWORD 'migrator-local-password'"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "GRANT CONNECT, CREATE ON DATABASE onecore_dev TO onecore_migrator"
psql "$ADMIN_DATABASE_URL" -d onecore_dev -v ON_ERROR_STOP=1 -c "GRANT USAGE, CREATE ON SCHEMA public TO onecore_migrator"
export DATABASE_URL='postgresql://onecore_migrator:migrator-local-password@127.0.0.1:5432/onecore_dev'
npm ci
npm run db:migrate
```

Create the non-owner `onecore_app` role before applying migrations. The
migrations grant its reviewed table and column privileges; do not use ad-hoc
table grants. The API role must never receive `BYPASSRLS`:

```sh
psql "$ADMIN_DATABASE_URL" -d onecore_dev -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE onecore_app LOGIN NOBYPASSRLS PASSWORD 'replace-with-a-local-only-password';
GRANT CONNECT ON DATABASE onecore_dev TO onecore_app;
SQL
```

The runtime-role migration grants only the access used by the services. Narrow
timestamp-column `UPDATE` privileges on membership, organization, branch, and
branch-assignment tables support the trusted context helpers' `SELECT ... FOR
SHARE` row locks; they do not grant table-level `UPDATE` or access to
domain/key columns. Set the API `DATABASE_URL` to this role after migrations.
Expand grants only as new trusted services require them; never grant table
ownership, schema-management privileges, or RLS bypass to an API.

For development seeding only, provision a separate local `onecore_seed` role with `BYPASSRLS`, schema usage, and DML access after migrations have created the tables. Use a throwaway local password and never create this role in staging or production:

```sh
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE onecore_seed LOGIN BYPASSRLS PASSWORD 'replace-with-a-local-only-password';
GRANT CONNECT ON DATABASE onecore_dev TO onecore_seed;
GRANT USAGE ON SCHEMA public TO onecore_seed;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onecore_seed;
SQL
export DATABASE_URL='postgresql://onecore_seed:local-only-password@127.0.0.1:5432/onecore_dev'
ONECORE_ALLOW_DEMO_SEED=YES npm run db:seed
```

Before seeding, explicitly confirm the target is a disposable local database by running `ONECORE_ALLOW_DEMO_SEED=YES npm run db:seed`; the seed rejects `NODE_ENV=production` and refuses to run without this opt-in. Seed identities include a platform Superadmin separate from organization memberships, each demo organization's owner, and a multi-organization identity. By default these users have no password. Set `ONECORE_DEMO_PASSWORD` to a development-only value of at least 16 characters when seeding if local authentication is required. The seed never prints the password. The shared development password must never be reused outside local development.

`DATABASE_URL` is read by migration, seed, and API startup. The API requires the non-owner application role; the liveness endpoint itself remains process-only. The checked-in `.env.example` uses only replaceable local placeholders. Set TLS options in the production connection URL or managed PostgreSQL provider configuration; obtain secrets from the deployment secret manager.

## Schema and migrations

- Edit the typed Drizzle declarations in `schema/`.
- Generate a migration with `npm run db:generate`.
- Review generated SQL, including constraints, RLS, and audit-trigger effects; update migration documentation/tests if needed.
- Commit both the schema and migration. Never edit a deployed database manually or use schema-push in production.
- Apply committed SQL with `npm run db:migrate`. The command must run using a separate schema-owner migration credential.
- Run `npm run test -w @onecore/database` to apply every migration against a clean in-memory PostgreSQL-compatible database and check tenant policies and constraints.

Use expand → migrate → verify → contract. Add nullable/new structures first, backfill in a bounded and observable migration or job, verify old and new readers/writers, and only then remove obsolete structures in a separately reviewed contract migration. Migrations are forward-only: use a compensating migration or restore a verified backup rather than assuming a down migration is safe.

Before applying the identity migration to a populated Phase 2 database, check for values that cannot satisfy the new constraints:

```sql
SELECT status, count(*) FROM users
WHERE status NOT IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED')
GROUP BY status;

SELECT lower(email), count(*) FROM users
GROUP BY lower(email)
HAVING count(*) > 1;
```

Resolve invalid lifecycle values and duplicate case-insensitive identities through an explicitly reviewed account reconciliation before migration. The migration intentionally does not guess which duplicate identity to retain. Clean-database and ordered migration tests run in PGlite. Live migration and tenant-security validation was also completed against PostgreSQL 18.6 on 2026-10-05; a live upgrade and operational verification against the production managed PostgreSQL service is still required before production.

## Live PostgreSQL validation

The local live-validation target used the `postgres:18` image (PostgreSQL 18.6). Use `onecore_migrator` only for migrations and `onecore_app` only for API connections. The migration role needs `CONNECT, CREATE` on the database because Drizzle creates its `drizzle` migration-metadata schema, plus `USAGE, CREATE` on `public`; it owns the migrated tables but need not own the `public` schema. Do not give database `CREATE`, schema `CREATE`, table ownership, or `BYPASSRLS` to `onecore_app`.

`npm` scripts do not load `.env`; export the correct role-specific `DATABASE_URL` before invoking them. Run `npm run db:generate` and confirm there are no unexpected schema changes, then run `npm run db:migrate` as `onecore_migrator`. Configure the API runtime with the `onecore_app` URL only after migration. Never put either password in source control.

For an RLS smoke check, use an administrative connection only to establish disposable fixtures, then switch the test transaction to `onecore_app` and set context transaction-locally:

```sql
BEGIN;
SET LOCAL ROLE onecore_app;
SELECT set_config('app.current_organization_id', '<verified-organization-uuid>', true);
SELECT id FROM branches;
ROLLBACK;
```

Verify that a tenant sees only its own rows and cannot read, update, or delete another tenant's rows; repeat with missing context and confirm no rows are visible and tenant writes are denied. Verify forced RLS independently with the migration/table-owner role and no context. Check `pg_class.relrowsecurity` and `relforcerowsecurity`, confirm protected-table owners are not `onecore_app`, and inspect `pg_roles.rolsuper` and `rolbypassrls` for both roles. Also exercise the membership-verified branch helper, same-tenant composite references, cross-tenant reference rejection, and simultaneous transactions using different organizations. The PGlite suite remains the fast automated migration suite; it is not a substitute for this real-server check.

PostgreSQL 18.6 emitted harmless notices that two generated foreign-key identifiers longer than PostgreSQL's 63-byte identifier limit were truncated. Migrations completed, their constraints were present, and `db:generate` reported no schema drift afterward; do not treat those notices as failed migrations.

On 2026-10-07, the Phase 12 authorization foundation was additionally validated
against PostgreSQL 18.6 in a disposable database with all 29 migrations
applied. Fifteen live checks passed as `onecore_app`, including RLS isolation
without context and direct cross-tenant/cross-branch query denial, branch and
owner scope for existing job/storage/search services, forged organization and
branch rejection, module entitlement enforcement, suspended-organization
denial, and storage-key length. The disposable database and filesystem fixture
were removed. This does not validate production managed PostgreSQL or business
domain resources; business-domain authorization remains deferred until those
resources and routes exist.

## Connections and transactions

`createDatabase(connectionString)` is the single PostgreSQL connection factory. Repositories and trusted services should accept database/transaction dependencies and keep queries out of HTTP handlers and apps. Use `withActiveOrganizationTransaction` to verify an active user, active membership, and active organization before setting `app.current_organization_id`; use `withActiveBranchTransaction` to verify active branch access and set `app.current_branch_id` as well. The lower-level `withOrganizationTransaction` is internal to trusted provisioning/seed work and is not exported from the database package; it is not an authorization check. Keep every tenant query inside its transaction callback; do not start unrelated pooled queries from inside the callback.

Branch access defaults to `ASSIGNED` and is fail-closed. Set a membership to `ALL` only through a trusted administration path; otherwise access comes from its `membership_branches` rows. Branch switching requires an active organization membership, active organization, active branch in that organization, and either `ALL` scope or an explicit branch assignment. Changing organization clears the saved branch atomically. Membership, organization, and branch state are rechecked when session context is resolved. Phase 12 applies authorization-derived row predicates to existing job, stored-object, and indexed-search operations. The reusable resource policy constrains organization in every query and applies supported organization, branch, owner, and assignee scope; unsupported scope/resource combinations return no rows. Jobs and stored objects map `OWN`/`SELF` to `created_by_user_id`; indexed search has no owner column and does not grant owner-only access. These are platform service resources, not business-module implementations.

The initial Sales foundation uses one transaction for an unpaid sale, immutable catalog snapshots, audit, idempotency, and its outbox event. It does not include inventory movements, payment, financial entries, or their guarantees. Any future workflow combining those domains must integrate real supported models in one transaction rather than treating this sale record as stock/payment state.

## Database roles

Use distinct credentials:

- **Migration owner:** owns schema objects and applies reviewed migrations; never used by an API.
- **Application role:** `NOBYPASSRLS`, does not own tables, and has only necessary DML grants. It must not have schema/role management privileges.
- **Seed role:** local development only, explicitly `BYPASSRLS` to create the initial organizations and fictional demo data. Never create or use it in staging or production.
- **Outbox/operations role:** only if required by future deployment; grant narrowly scoped access and do not reuse tenant API credentials.

The migration enables and forces RLS on tenant and identity tables. A missing transaction context hides tenant rows and blocks writes. `organizations` is restricted by `id`; tenant tables are restricted by `organization_id`. Identity table policies additionally constrain user reads to the server-resolved user ID or normalized login email and constrain session access to the authenticated user or presented session digest. Authenticated-user context permits a user to see only their own memberships and organizations with active membership. Scoped composite foreign keys prevent associations from crossing organizations even if an application query is incorrect. The feature-flag policy exposes platform-scope assignments for evaluation but allows tenant app writes only to that tenant's assignments.

**The application must not run as a superuser, table owner, or `BYPASSRLS` role.** Those roles can bypass RLS. The organization context must be resolved from an authenticated server-side session and active membership; the transaction helper does not authenticate callers.

## Seed data

`npm run db:seed` is idempotent and creates only the fictional Demo Retail Ltd, Demo Hotel Ltd, and Demo School Ltd examples, plus platform administration/configuration metadata. It does not create POS, inventory, finance, education, hotel, or other business-module implementations, and must never be run against a production customer database.

## Test strategy

The database tests instantiate a clean PGlite PostgreSQL-compatible database, apply the exact checked-in migration SQL in order, use a non-bypass application role for RLS checks, and exercise memberships, branch assignment, tenant role/permission relationships, module/feature/flag separation, custom-field references, workflow version activation, audit immutability, and invalid references. Production deployment pipelines must additionally verify the supported managed PostgreSQL service, migration backup/recovery, and restore process.

## Phase boundary

This package supplies persistence and identity repositories, Business Manager master data, and limited Sales and Inventory foundations documented in [the Sales module note](../docs/modules/sales.md). Sales records are unpaid and reserve available product stock; Inventory supports branch balances and receipt/adjustment movements, not a complete purchasing or costing module. Business-resource authorization is implemented only for the named resources and routes, not as a general business authorization claim. OAuth, MFA, password recovery, payment gateways, purchasing, accounting, and full inventory management remain deferred. Do not add customer-specific application forks.
