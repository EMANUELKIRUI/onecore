# Database migrations

PostgreSQL 16+ and Drizzle Kit are selected for Phase 2; see [ADR 0002](../../docs/architecture/adr/0002-postgresql-drizzle-persistence.md). Drizzle schema source is in `../schema/`; reviewed migration SQL is stored in timestamped directories here. The installed Drizzle ORM migrator reads each directory's `migration.sql`; it does not need a `_journal.json`. Legacy `meta/_journal.json` migration folders are rejected by this runner. Snapshots are generator metadata, not runtime migration evidence.

## Supported migration entry point and preflight

Use `npm run db:validate` for a read-only preflight and `npm run db:migrate`
only for an explicitly approved migration. Both commands use
`database/scripts/migrate.ts`; direct `drizzle-kit migrate` is blocked by the
config guard, but that guard is not a security boundary against custom code
that imports Drizzle's migrator.

npm does not load `.env` automatically. Supply `MIGRATOR_DATABASE_URL` for
the dedicated `onecore_migrator` login through the approved secret manager or
a protected shell. The migration runner never falls back to `DATABASE_URL`,
which remains for API/worker runtime and the development seed. Do not place
the migrator URL in command arguments, `.env.example`, logs, or source control.
Also set these non-secret target values for every invocation:

```sh
export ONECORE_MIGRATION_ENVIRONMENT=development
export ONECORE_MIGRATION_EXPECTED_HOST=127.0.0.1
export ONECORE_MIGRATION_EXPECTED_PORT=5432
export ONECORE_MIGRATION_EXPECTED_DATABASE=onecore_dev
npm run db:validate
```

Provide `MIGRATOR_DATABASE_URL` securely before either `npm run db:validate`
or `npm run db:migrate`; both commands select only that variable and fail
closed when it is absent, even when `DATABASE_URL` is set. The selected URL
must authenticate as `onecore_migrator` and match the independently verified
host, port, and database below.

For `test`, use `ONECORE_MIGRATION_ENVIRONMENT=test` and a loopback disposable
database. Development and test endpoints are restricted to loopback. Staging
and production additionally require `ONECORE_MIGRATION_EXPECTED_RESOURCE_ID`;
production requires `NODE_ENV=production` and
`ONECORE_MIGRATION_CONFIRM_PRODUCTION=<resource-id>/<database>`. Initializing an
empty staging or production database also requires
`ONECORE_MIGRATION_INITIALIZE_EMPTY_DATABASE=<resource-id>/<database>`.
Any uncommitted migration SQL or metadata blocks staging and production. In
development/test, every uncommitted migration must be named exactly in the
comma-separated `ONECORE_MIGRATION_REVIEWED_UNTRACKED` variable.

The expected host, port, database, environment, and provider resource ID must
be independently checked against the approved deployment record before a
remote migration. PostgreSQL can report the connected database and roles, but
cannot attest that its endpoint belongs to a particular Render resource ID.
These environment values are operator assertions, not provider identity
proofs.

The supported `onecore_migrator` login must be `NOSUPERUSER`, `NOBYPASSRLS`,
`NOCREATEDB`, `NOCREATEROLE`, and `NOREPLICATION`, have no role memberships,
and must not own the database. It needs effective `CONNECT` and `CREATE` on
the database for Drizzle metadata, and `USAGE, CREATE` on `public`. Existing
application objects and Drizzle metadata must be owned by this role. Its
literal `search_path` must be exactly `public`. Do not use the API, worker,
seed, superuser, database-owner, or RLS-bypass role for migrations.

`npm run db:validate` checks target identity and privileges in a read-only
transaction, validates the ledger and repository migration files, and never
invokes Drizzle's migrator. An uninitialized remote target is not migrated
unless the exact resource/database initialization confirmation is supplied.
Validation is not a backup, a production data-presence check outside the
connected database, or independent proof of provider resource identity.

The installed Drizzle migrator sorts directories by name, selects pending
migrations by ledger `name`, and records the SQL SHA-256 hash and folder
timestamp. It does not compare a previously stored hash or require that the
applied rows form a complete prefix. It creates the configured metadata schema
and ledger table before running pending migration SQL and ledger inserts in a
transaction. A failed invocation can therefore leave metadata objects behind;
the migration runner reports this uncertainty and requires read-only
reconciliation before retry. The OneCore preflight adds the history checks.
If a ledger row is missing a usable name, timestamp, or checksum, if a stored
checksum differs, if rows are duplicated/out of order, or if application
objects exist without a ledger, stop and reconcile the complete target state
with the migration owner. Never manually insert, update, delete, or fabricate
ledger rows to bypass a failed check; never infer success from filenames or a
later ledger row.

Before a real migration, independently verify the provider resource and target,
review all pending SQL and the migration ledger, obtain migration-owner
approval, and take and validate a restorable backup. On uncertain or failed
forward-only migrations, stop the runner and use an approved, evidence-based
recovery plan: reconcile partial effects before a reviewed compensating
migration, or restore a verified backup. Do not blindly retry, skip, baseline,
or rewrite migration history. PGlite tests and local validation do not establish
production database identity or state.

Run the focused safety tests and database regression suite only against the
repository's local test tooling:

```sh
npm run test -w @onecore/database -- tests/migration-target.test.ts tests/migration-history.test.ts tests/migration-runner.test.ts tests/migration-git-state.test.ts
npm run typecheck:test -w @onecore/database
npm run test -w @onecore/database
```

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

The follow-up session insert grant migration adds INSERT privileges only for
the generated `id` and `revoked_at` columns. Drizzle includes both as
`DEFAULT` when creating a session, so column-level INSERT privileges must
cover them even though the API does not set either value during login. This
grant does not expand the runtime role to table-wide INSERT privileges.

Forward-only migration `20261012110014_owner_credential_setup` adds the
organization-bound Owner credential-setup token table with forced RLS, a
single-token/user identity policy, and narrowly scoped update grants. It also
grants the application role only the user password/email-verification columns
and membership status column needed to complete setup transactionally. Token
hashes—not raw invitation tokens—are persisted. Validate its policies and
privileges against the non-owner runtime role in disposable PostgreSQL before
any deployment; no production migration state was queried.

Forward-only migrations `20261012092151_orange_proudstar` and
`20261012092652_safe_iron_lad` add `user_mfa_credentials` and
`sessions.mfa_verified_at`. MFA credentials are identity-level data protected
by forced RLS using only `app.current_user_id`; organization or branch context
does not make another user's encrypted TOTP secret visible. The runtime role
receives DML only on that table, with the API required to set its verified
user context. The session-assurance migration grants INSERT only on the added
`mfa_verified_at` column. Review both generated migrations and their RLS/grant
statements before applying them. They have been exercised only in disposable
local PostgreSQL-compatible tests; no production ledger or database was
queried.

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
An isolated PostgreSQL-compatible regression test reproduced a failure in the
original unscoped role-permission backfill when pre-existing Owner/Admin rows
were protected by forced RLS. The migration source now sets
`app.current_organization_id` for each tenant before inserting that tenant's
branch grants. Do not apply this changed migration file to an existing target
until its recorded history and effects have been reconciled: the source change
changes its content hash, and a missing ledger entry does not establish that
the prior version had no partial effects.

A forward-only repair migration,
`20261010040000_branch_permission_backfill_repair`, also sets
`app.current_organization_id` per tenant and backfills missing branch and
membership-branch permissions. It is repeatable, but does not replace or
bypass the predecessor. The migration regression test covers the corrected
predecessor with existing Owner/Admin roles, forced RLS, two-tenant isolation,
repeatability, and rollback after a later transaction failure.

Before migration or recovery in any environment, inspect that environment's
ledger and verify the resulting permission rows using an authorized
read-only connection. If `20261010020000_branch_administration_contract` is
recorded, verify its hash, effects, and security properties; do not rerun it
or edit its ledger entry. Continue with the ordered runner only after
migration-owner approval. If it is absent from the ledger, stop normal
migration retries until an authorized operator determines whether the old SQL
partially applied. Recovery requires migration-owner approval and a controlled
plan that reconciles all effects under tenant-scoped writes before recording
successful completion, or a verified backup restore followed by the approved
recovery procedure. Never insert a ledger row by itself, skip the predecessor,
bypass RLS, or assume the later repair will execute. No deployment ledger was
inspected as part of this change.

The migration owner should provide the following read-only evidence for the
specific target database and environment before deciding the recovery path:

1. The migration ledger schema and rows for
   `20261008083900_phase18_workflow_runtime` and
   `20261010000000_workflow_worker_discovery`,
   `20261010020000_branch_administration_contract`,
   `20261010030000_membership_branch_assignment_contract`, and
   `20261010040000_branch_permission_backfill_repair`, plus
   `20261010140000_session_revoked_at_insert_grant` and
   `20261011000000_worker_notification_id_insert_grants`, including each
   available `id`, `name`, `hash`, and `created_at`. For a target beyond these
   versions, reconcile every intervening migration in timestamp order as well.
   The default Drizzle ledger is `drizzle.__drizzle_migrations`; confirm its
   actual schema and columns before querying, and compare recorded
   hashes/timestamps with the reviewed migration artifacts. Do not infer
   success from the presence of a later row or manually add a row.
2. For every organization containing a system `Organization Owner` or
   `Organization Admin` role, the role ID/status and the presence or absence
   of each of these six role grants, including `scope_type` and `scope`:
   `core.organization.branch.read`,
   `core.organization.branch.create`,
   `core.organization.branch.update`,
   `core.organization.membership_branch.read`,
   `core.organization.membership_branch.assign`, and
   `core.organization.membership_branch.remove`. The expected grant is
   organization-scoped with an empty JSON scope. Include missing combinations
   rather than reporting only existing rows.
3. Catalog evidence for `roles`, `role_permissions`, `permissions`,
   `branches`, `membership_branches`, `sessions`, `jobs`, `job_attempts`,
   `workflow_executions`, `workflow_execution_actions`, `notifications`, and
   `notification_deliveries`: table owner, whether RLS is enabled and forced,
   and applicable policy definitions. Also provide the `onecore_app`,
   `onecore_migrator`, `onecore_worker`, and dedicated worker-login role flags
   (`rolsuper` and `rolbypassrls`), role membership, and effective relevant
   grants. Confirm that runtime and migrator roles are not superusers or RLS
   bypassers, protected tables remain migration-role owned, and the worker
   login is a member only of the non-login worker role. Verify the worker's
   notification INSERT privileges are column-scoped: the follow-up migration
   adds `id`, `read_at`, and `created_at` on `notifications`, and `id`,
   `next_attempt_at`, `last_error_code`, `created_at`, and `updated_at` on
   `notification_deliveries`; table-level INSERT remains absent. Branch,
   membership-branch, and session grants must remain narrowly scoped too.

The evidence is for reconciliation only; it does not authorize a migration,
ledger update, or production change. If the historical migration is absent,
the remaining action is an approved operator recovery that applies and
verifies its complete effects under tenant-scoped writes before recording
success, followed by the ordered migration runner. If it is already recorded,
verify the rows and security properties above, then use the normal runner to
apply the later migrations. Obtain the migration owner's approval and an
approved recovery/restore plan before either path.

The membership-branch assignment contract reuses the existing
`membership_branches` relation, composite tenant foreign keys, and forced RLS
policy. It adds separate organization-scoped read, assign, and remove
permissions, backfills the two administrative system roles, and grants
`onecore_app` only the required association insert columns and delete
operation. No schema snapshot change is needed. Review
`20261010030000_membership_branch_assignment_contract/migration.sql` and
apply it with `onecore_migrator`; assignment writes remain tenant-scoped by
`app.current_organization_id`.

## Sales checkout foundation

The forward-only migration `20261010184156_sales_checkout_foundation` adds
tenant-owned `sales` and `sale_lines`, the `core.sales` module/permission
catalog metadata, forced tenant RLS, immutable transaction snapshots, and
column-scoped `onecore_app` grants. It intentionally creates no organization
entitlements, plan eligibility, role grants, inventory records, or payment
records. It follows the existing migration chain and is not a repair or a way
around `20261010020000_branch_administration_contract`.

The ordered disposable PGlite suite has replayed the checked-in migrations,
including this addition. No external migration ledger was inspected and this
migration was not applied to a deployment. Before applying it to any target,
the migration owner must follow the read-only ledger/RLS/permission evidence
procedure above. If the branch-administration predecessor is absent and
blocked by its forced-RLS backfill, stop the ordered runner and use only the
approved recovery process already documented here; do not skip, rewrite, or
manually mark any migration successful.

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
