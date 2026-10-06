# Database migrations

PostgreSQL 16+ and Drizzle Kit are selected for Phase 2; see [ADR 0002](../../docs/architecture/adr/0002-postgresql-drizzle-persistence.md). PostgreSQL 18.6 live migration and RLS validation completed on 2026-10-05. Drizzle schema source is in `../schema/`; generated, reviewed SQL migrations and Drizzle snapshots/journal are stored here.

Run `npm run db:generate` to generate a migration and `npm run db:migrate` to apply committed SQL using a `DATABASE_URL` for `onecore_migrator`. This role requires database `CREATE` for Drizzle's migration metadata schema and `USAGE, CREATE` on `public`; the API must use `onecore_app`, which is neither a table owner nor `BYPASSRLS`. npm does not load `.env` automatically, so export the appropriate role-specific URL before each command. Never use schema push or manually edit a production database. Migrations are forward-only; recover through a compensating migration or verified backup restore.

Schema changes follow **expand → migrate → verify → contract**. Destructive contract steps require explicit review after deployed readers and writers no longer depend on the old schema. Tenant scoping is enforced in trusted server-side query boundaries and by PostgreSQL RLS; application connections must not own protected tables or bypass RLS.

Phase 5 reuses the existing RBAC tables. Its migration adds canonical
structured permission fields, role and permission lifecycle, data scope on
role grants, and reusable permission catalog entries. Roles, role grants,
membership-role assignments, and membership data scopes remain organization
scoped with the existing composite foreign keys and forced RLS. Apply through
the migration role. Least-privilege RBAC and identity grants are applied by
the forward-only runtime-role grants migration.

The permission catalog is global and read-only to the API. Never make
`onecore_app` an owner or grant it `BYPASSRLS`.
See [RBAC security documentation](../../docs/security/rbac.md).

Phase 6 extends the existing module catalog with an explicit lifecycle and
backfills versioned manifests for existing module rows. The migration grants
the runtime role read access to registry and subscription/plan facts and only
`SELECT, INSERT, UPDATE` on tenant-scoped organization module entitlements.
Global lifecycle changes use the registry service with the separate
`onecore_migrator` connection; it does not grant global catalog writes to the
API role. The migration-role-only audit policy permits platform registry
events in the existing append-only audit table. A separate narrow
`platform_user_roles` insert policy lets only `onecore_migrator` provision
platform-role assignments. The development seed receives only read/insert
policies on organization roots so it can provision idempotent demo tenants;
it receives no organization update/delete policy. `onecore_app` remains
read-only on platform-role assignments.
Review
[module entitlement security](../../docs/security/module-entitlements.md)
before granting deployment roles.

## Phase 7 configuration grants

Configuration grants are also applied by the forward-only runtime-role grants
migration. Custom-field record values are not exposed by these APIs and must
not be granted until an authorized business-record service needs them.

The standard identity, audit, RBAC, and Phase 6 entitlement grants above are
still applied cumulatively. Never grant table ownership, schema `CREATE`,
`BYPASSRLS`, or `GRANT ALL` to
`onecore_app`. All listed tenant tables have forced RLS; verify their owner is
the migrator role and test tenant isolation using the runtime role.

Phase 4 adds a typed branch lifecycle, fail-closed membership branch-access mode, and a session branch ID constrained to the selected organization. The branch status migration normalizes existing status casing and rejects values outside the typed lifecycle; review existing production branch status values before applying it.

Phase 10 adds PostgreSQL-backed rate-limit buckets. The migration enables and
forces RLS, permits global buckets only when no organization or branch GUC is
active, and scopes tenant buckets to the exact transaction-local organization
and branch. It grants the API role only the DML operations needed for atomic
bucket updates; the migration role remains the table owner. See
[observability and security operations](../../docs/security/observability.md).

The runtime-role grants migration consolidates the documented identity, RBAC,
and configuration privileges into forward-only SQL. Identity updates and
session creation/update are column-scoped; role creation/update is limited to
the fields accepted by the RBAC API. Narrow timestamp-column update privileges
support the `SELECT ... FOR SHARE` locks used to validate membership,
organization, branch, and branch-assignment context; table-level update
privileges remain absent. Create the `onecore_app` role as non-owner and
`NOBYPASSRLS` before applying migrations; do not provision its table access
with ad-hoc grants.

## Production lifecycle mutations

The lifecycle mutation migration grants the runtime role column-scoped `INSERT`
on organizations, users, memberships, and outbox events, plus organization
status updates. Trusted organization provisioning may insert only the
established system-role templates, with a `SUPERADMIN` platform role required
by restrictive RLS policy for system-role writes; tenant policies continue to
bind every row to transaction-local organization context. User creation and
invitations run only inside the authorized organization transaction using
`core.organization.user.create`. Do not grant table ownership or broader
update/delete privileges to enable these paths.
