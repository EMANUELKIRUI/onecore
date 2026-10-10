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

The organization member-directory migration adds a SELECT-only policy on the
existing `users` table; it does not alter table structure or runtime grants.
The policy requires both the verified organization GUC and the
transaction-local directory marker set by the API only after the canonical
organization-scoped `core.organization.user.read` authorization succeeds.
Without that marker, user visibility remains limited to the current identity
or login lookup. Review the additive policy in
`20261010010000_organization_member_directory/migration.sql`; no Drizzle
snapshot change is needed because the migration changes only an RLS policy.

The branch-administration contract migration is additive: it inserts the
canonical branch permission catalog entries, grants them to existing system
Organization Owner/Admin roles, and grants the API only the branch insert and
update columns used by the branch API. It changes no table structure or RLS
policy, so no Drizzle snapshot change is required. Branch inserts name only
`organization_id`, `name`, and `code`; forced tenant RLS remains the row
boundary. Review
`20261010020000_branch_administration_contract/migration.sql` before applying.
An isolated PostgreSQL 18.6 replay of its role-permission backfill with
pre-existing Owner/Admin rows failed as `onecore_migrator` because the
cross-tenant `role_permissions` insert has no transaction-local organization
context. The deployment migration ledger must be checked before any repair;
never edit this migration if it has been applied. A forward-only repair
migration, `20261010040000_branch_permission_backfill_repair`, sets
`app.current_organization_id` per tenant and backfills the missing branch and
membership-branch permissions for every Organization Owner/Admin system role
without widening tenant scope. The repair is repeatable and safe after the
earlier backfill, but it does not replace or bypass that migration. The normal
ordered runner cannot reach it while the predecessor is absent from the ledger
and failing.

Before migration or recovery in any environment, inspect that environment's
ledger and verify the resulting permission rows using an authorized
read-only connection. If `20261010020000_branch_administration_contract` is
recorded, verify its effects and continue with the normal runner; the later
repair will fill any missing branch or membership-branch grants. If it is not
recorded, stop normal migration retries. Do not insert a ledger row by itself,
skip the predecessor, or assume the later repair will execute. The migration
owner must approve a controlled recovery that applies and verifies all effects
of the predecessor, using tenant-scoped role-permission writes and preserving
its grants, before truthfully recording successful completion in the ledger.
Alternatively, restore a verified backup and follow the approved recovery
procedure. A new later migration alone is not a recovery for this ordering
failure. No deployment ledger was inspected as part of this change.

The membership-branch assignment contract reuses the existing
`membership_branches` relation, composite tenant foreign keys, and forced RLS
policy. It adds separate organization-scoped read, assign, and remove
permissions, backfills the two administrative system roles, and grants
`onecore_app` only the required association insert columns and delete
operation. No schema snapshot change is needed. Review
`20261010030000_membership_branch_assignment_contract/migration.sql` and
apply it with `onecore_migrator`; assignment writes remain tenant-scoped by
`app.current_organization_id`.

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
