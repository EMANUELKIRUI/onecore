# Deployment and governance

Phase 2 adds a production-database migration boundary. Hosting and release procedures remain deployment-specific; this guide documents the runtime configuration contract without provisioning infrastructure.

## Runtime environment

The API validates environment variables at startup through `@onecore/config`. `NODE_ENV` must be exactly one of `development`, `test`, `staging`, or `production`; production is explicitly supported, and other values are rejected. The `.env.example` file uses `development` for local work. Staging/production or a supplied `PORT` defaults the listener to `0.0.0.0`; local development retains `127.0.0.1`. The port uses `process.env.PORT` when provided and otherwise defaults to `3000`. Set `NODE_ENV=production` for a production service and provide Render's assigned `PORT` and PostgreSQL `DATABASE_URL`. The API's checked-in Render service uses `npm ci && npm run build` and `npm start`; automatic deploy is disabled. `AUTH_ALLOWED_ORIGINS` must contain exact browser origins forwarded by the same-origin proxy for mutation origin validation; CORS middleware is not needed for these same-origin requests.

First-Owner setup invitations additionally require the server-side
`BUSINESS_APP_ORIGIN` (the exact HTTPS origin of the Business static app),
`MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`, and `RESEND_FROM_EMAIL`. Configure
`RESEND_BASE_URL` only to an approved HTTPS Resend-compatible endpoint. Keep all
provider credentials in API deployment secrets, not frontend build variables.
Provider acceptance is not delivery confirmation. The sender domain, production
values, and end-to-end delivery must be verified before enabling invitations;
live email delivery was not exercised by repository tests.

## Static frontend deployment

`AUTH_MFA_ENFORCEMENT` defaults to `required`. The temporary `disabled` value
is accepted only with an explicitly configured `NODE_ENV=development` or
`NODE_ENV=test`; configuration loading rejects it in staging and production.
Do not set or deploy the disabled value to a hosted environment. Removing the
setting or restoring `required` re-enables the existing role-based TOTP policy.

Marketing, Business, Superadmin, and Support are separate native static HTML, CSS, and ES-module applications. Each Vercel project uses its corresponding `apps/<name>` Root Directory, runs the checked-in build command, and publishes `dist`. Enable Vercel's **Include files outside the Root Directory** setting so the build can read `scripts/build-static-app.mjs` and `packages/ui`; the build copies the required shared stylesheet and modules into each app output. No bundler or external frontend dependency is required. Superadmin provides the organization application review API; Support uses session-authenticated, row-level-secured request routes and remains unavailable when its API is not configured or reachable.

Marketing, Business, Superadmin, and Support configure `ONECORE_API_BASE_PATH=/api` in
their checked-in Vercel build commands and rewrite `/api/:path*` to
`https://onecore-api.onrender.com/:path*`. The API routes are rooted at `/`;
the rewrite removes the frontend-only `/api` prefix. This same-origin path lets
the frontend API client send the host-only session cookie without browser CORS.
Support uses the same `/api` rewrite and host-only session-cookie flow now
that its authenticated support routes exist. Verify the live Vercel project
root, API rewrite destination, `ONECORE_MARKETING_URL`, and the exact
`AUTH_ALLOWED_ORIGINS` entry before enabling the Support deployment.

Set `ONECORE_BUSINESS_URL` on Marketing and `ONECORE_MARKETING_URL` on Business,
Superadmin, and Support to the corresponding public app URLs; each Vercel build
fails if its required cross-app URL is missing. The static build injects these
values into cross-app links. Configure `AUTH_ALLOWED_ORIGINS` on the Render API
with the exact deployed Marketing, Business, Superadmin, and Support HTTPS origins.
These origins are checked for state-changing requests; do not use wildcards.
Keep all frontend build values public and never place credentials or service
secrets there.

## Initial Superadmin provisioning

The initial platform administrator is a global `SUPERADMIN` platform-role
assignment, not an organization membership. After the reviewed
`20261014150000_initial_superadmin_bootstrap` migration has been applied by the
approved migration process, build the workspace and run
`npm run bootstrap:superadmin -w @onecore/api` from an approved administrative
host. The only permitted initial root address is
`emanuelkirui1@gmail.com`. The command requires `MIGRATOR_DATABASE_URL` for
`onecore_migrator` and uses the same explicit target safeguards as migrations.
It rejects an absent/blank URL, a mismatched expected host, port or database,
an invalid environment, and production without the expected provider resource
ID and confirmation. npm does not load `.env` automatically; provide the
credential through the approved secret manager or protected shell, never in
command arguments, logs, or committed files.

For a disposable local database, first supply the local migrator URL securely,
then set the non-secret target values and run:

```sh
export NODE_ENV=development
export ONECORE_MIGRATION_ENVIRONMENT=development
export ONECORE_MIGRATION_EXPECTED_HOST=127.0.0.1
export ONECORE_MIGRATION_EXPECTED_PORT=5432
export ONECORE_MIGRATION_EXPECTED_DATABASE=onecore_dev
npm run build
npm run bootstrap:superadmin -w @onecore/api
```

For production, run only from an approved administrative host after separately
verifying the Render resource, database, applied bootstrap/support migrations,
and approval to provision. Set `NODE_ENV=production`,
`ONECORE_MIGRATION_ENVIRONMENT=production`,
`ONECORE_MIGRATION_EXPECTED_HOST`, `ONECORE_MIGRATION_EXPECTED_PORT`,
`ONECORE_MIGRATION_EXPECTED_DATABASE`,
`ONECORE_MIGRATION_EXPECTED_RESOURCE_ID`, and
`ONECORE_MIGRATION_CONFIRM_PRODUCTION` to the exact independently verified
`<resource-id>/<database>`. Source `MIGRATOR_DATABASE_URL` through the approved
secret manager without echoing it. Build, then run the same npm bootstrap
command interactively. The bootstrap itself does not run or validate
migrations; stop if the approved migration process has not confirmed the
required schema is installed.

The command requires an interactive TTY, asks for a display name, requires the
operator to type `CREATE emanuelkirui1@gmail.com`, and prompts twice for a
password without echoing it. Passwords must be 16–1024 characters and are
stored only as an Argon2id hash. It creates an active user, one `SUPERADMIN`
assignment, and the root marker only when no existing Superadmin or root
marker conflicts. Repeating it for an already-provisioned root account does
not change the password or duplicate roles. Any other existing account,
incomplete or conflicting root/Superadmin state, or a mismatched connected
database causes a refusal for operator review. No organization membership is
created. Sign-in requires TOTP enrollment;
configure the API-only `MFA_ENCRYPTION_KEY` through the approved secret
manager before enrollment. Then verify sign-in and access through the deployed
Superadmin portal and its same-origin `/api` proxy.

The current Superadmin UI and API do not provide general platform account
creation or subordinate-Superadmin invitations. Do not create subordinate
accounts manually or use the one-time root bootstrap to promote them. The
required generic secure account invitation/setup flow is not implemented.

## Organization deployment types

`SAAS`, `CUSTOM`, `DEDICATED`, and `ENTERPRISE` are persisted domain values on an organization and are available to future provisioning, billing, support, and deployment services. They are not yet a provisioning implementation:

- **SAAS:** intended shared OneCore service and database with strict organization isolation.
- **CUSTOM:** organization-specific configuration/branding/workflow/approved extensions on the shared platform contract; not a copied codebase or customer branch.
- **DEDICATED:** intended isolated deployment resources for an organization, provisioned through common automation and compatible platform releases.
- **ENTERPRISE:** contractual service tier that may combine dedicated resources, plan/entitlement policy, support, and approved extensions; not a separate code fork.

The exact infrastructure placement, residency, service levels, tenancy model for each deployment, and enterprise contract rules remain product/operations decisions. Do not infer them from the enum alone or scatter deployment-specific conditionals across modules.

## Database deployment

Use separate secret-managed credentials for schema migrations and application runtime. The migration principal owns/provisions application schema objects but must not own the database; it must have no superuser, RLS-bypass, database/role creation, replication, or inherited role privileges. The application principal must be a non-owner with `NOBYPASSRLS` and least-privilege grants. Configure TLS and network allowlists for the selected managed PostgreSQL service.

Use `npm run db:validate` for a read-only migration preflight and
`npm run db:migrate` only as an explicit migration action. Both require the
`onecore_migrator` login and non-secret
`ONECORE_MIGRATION_ENVIRONMENT`,
`ONECORE_MIGRATION_EXPECTED_HOST`, `ONECORE_MIGRATION_EXPECTED_PORT`, and
`ONECORE_MIGRATION_EXPECTED_DATABASE` settings. Staging and production also
require `ONECORE_MIGRATION_EXPECTED_RESOURCE_ID`, verified by the operator
against the current provider resource and deployment record. Production
requires `NODE_ENV=production` and
`ONECORE_MIGRATION_CONFIRM_PRODUCTION=<resource-id>/<database>`. The preflight
checks the server-reported database, authenticated/current role, role flags and
memberships, effective database/schema privileges, object ownership, literal
`search_path=public`, migration ledger schema, repository files, and recorded
checksums/order. It rejects application objects without reconcilable ledger
history and never edits the ledger. PostgreSQL cannot attest that its endpoint
belongs to the provider resource ID supplied by the operator; these checks do
not replace independent provider verification, migration-owner approval,
backup, and recovery review. See the [migration runbook](../../database/migrations/README.md).

The API must use a dedicated `onecore_app` login; the worker must use its own
login with membership only in the `onecore_worker` group role. These are
separate from `onecore_migrator`. In the provider dashboard, independently
confirm that the API and worker `DATABASE_URL` settings reference the same
approved PostgreSQL resource, without copying either value into logs or
tickets; confirm each login's effective grants using authorized read-only
catalog checks. The checked-in blueprint declares these settings as
operator-supplied and does not prove the live service configuration. Rotate
database credentials through the approved secret manager, update every
intended service consistently, and confirm the old credential is no longer
used before revoking it. Never expose URLs or passwords during comparison.

Before a release, obtain migration-owner approval and take a provider backup
or snapshot. Confirm its completion and restore it to an isolated database;
verify the restored schema and application-level consistency before treating
it as a recovery point. Then review and apply only the committed migration
with the approved migration job, verify schema and application health, and
monitor. Use expand → migrate → verify → contract. The installed Drizzle
migrator creates its metadata schema/table before its migration SQL and ledger
inserts transaction, so a failed invocation may leave metadata objects even
when the migration transaction rolls back. Re-run read-only validation and
reconcile transaction/ledger state before retrying; never manually edit the
ledger. Non-transactional effects or ambiguous commit outcomes require a
reviewed forward repair or a tested backup restore. Do not assume automatic
migration rollback. Backup existence and restore success must be verified for
the actual production provider before release; neither is established by this
repository or local tests.

## Disposable browser E2E

On Linux, install the Playwright Chromium runtime and its operating-system
dependencies before the first browser run:

```sh
npx playwright install --with-deps chromium
env -u DATABASE_URL NODE_ENV=test npm run test:e2e
```

The CI workflow uses the same Playwright installation command. The E2E runner
refuses production mode or an inherited `DATABASE_URL`; it starts a disposable
PostgreSQL container bound to loopback and explicitly supplies its generated
test-only target to the migration and API processes. Do not remove that guard
or run the suite with hosted credentials.

Configure the Render web service health-check path as `/ready`. `/health` and `/health/live` are liveness-only and do not query PostgreSQL. `/ready` performs a read-only PostgreSQL connectivity check bounded to two seconds and returns `503` with `{"status":"not_ready"}` if the check fails or times out; `/health/ready` is a compatibility alias. Neither readiness response nor liveness response exposes dependency details. The blueprint defines the `onecore-api` web service alongside the workflow worker, with automatic deploy disabled; adding this service to the file does not import it, change Render settings, or deploy it. No production deploy/rollback workflow exists yet.

## Workflow worker

The workflow worker is a separate Render background worker; it is not started
by the API and has no HTTP health endpoint. The checked-in [`render.yaml`](../../render.yaml)
provides a `onecore-workflow-worker` service definition with automatic deploys
disabled. Review its plan and branch settings before importing it into Render;
importing or deploying the blueprint is an operator action and has not been
done by this task.

Before starting the service:

1. Build and test the worker from the repository root with
   `npm run build:worker` and `npm run test -w @onecore/worker`.
2. Apply the worker-discovery migration and its ordered forward-only follow-up
   `20261011000000_worker_notification_id_insert_grants` through the approved
   migration process after reviewing the target, backup, and migration diff.
   The worker runtime migration `20261008083900_phase18_workflow_runtime`
   precedes discovery migration `20261010000000_workflow_worker_discovery`;
   the notification-grant migration runs only after every intervening
   timestamp-ordered migration. In particular, reconcile
   `20261010020000_branch_administration_contract` with the target ledger before
   invoking the ordered runner. If that predecessor is absent and its
   forced-RLS backfill fails, stop and follow the approved recovery procedure
   in [`database/migrations/README.md`](../../database/migrations/README.md);
   do not skip it or run the worker grant migration out of order. Do not apply
   migrations from the worker or API startup path.
3. Provision a dedicated login and grant it membership only in the
   `onecore_worker` `NOLOGIN NOSUPERUSER NOBYPASSRLS` group role. Do not reuse
   the API or migrator login. Configure the service's secret `DATABASE_URL`
   with that login, and set `LOG_LEVEL` plus optional worker tuning variables.
   Never place credentials in the blueprint or source control.
4. Start the background worker separately from the API. Verify `worker.ready`,
   `worker.poll.completed`, and matching `worker.job.claimed` /
   `worker.job.outcome` logs for a controlled run. Verify persisted job,
   execution, and notification state through the approved read-only,
   tenant-scoped database reconciliation procedure before considering it
   operational; no job-status HTTP API is currently available.

`DATABASE_URL` is required. `WORKER_POLL_INTERVAL_MS` defaults to `5000`
(250–60000), `WORKER_CONCURRENCY` defaults to `4` (1–16), and
`WORKER_SHUTDOWN_GRACE_MS` defaults to `30000` (1000–120000). `LOG_LEVEL`
uses the shared application configuration. The worker polls only
`core.workflow.execute`; it does not claim communication deliveries, webhooks,
or other generic job types.

Render reports process health from the background process lifecycle; there is
no synthetic HTTP readiness check. The worker logs `worker.ready`,
`worker.poll.completed`, `worker.job.claimed`, `worker.job.outcome`, and
failure/shutdown events. Repeated discovery/scope errors, retrying/failing
outcomes, or a growing eligible tenant queue without recent poll logs require
operator investigation. Database telemetry reports claim-batch lease recovery
and exhaustion counts plus per-attempt outcomes. There is no tenant-authorized
job list/attempt-history HTTP endpoint today, so use the central structured-log
system for operational observation; do not assume queue state is available from
an API or grant workers global queue access. Terminal jobs use `FAILED` state
and `JOB_FAILED` outbox/audit records, not a separate job dead-letter table.

On restart, `SIGTERM`/`SIGINT` stops new polling and allows in-flight database
transactions to finish during the grace period. If the grace period expires,
the database client is closed with a short timeout; interrupted transactions
roll back and their persisted leases are recovered after expiry. Run multiple
instances only with the worker role and existing PostgreSQL claim/lease logic.
Increase bounded concurrency only after measuring database capacity and
connection limits. Execution is at-least-once, so non-transactional side
effects in future handlers must be independently idempotent.

For rollback, stop or scale the worker service to zero first; already persisted
jobs remain durable and can be resumed after a compatible worker is restored.
Do not remove the worker role or its grants while any worker is active. The
additive database migration is not automatically rolled back with an
application release; use a reviewed forward repair if schema/privilege changes
are needed.

The worker build, unit tests, and isolated PostgreSQL lifecycle/lease tests
provide local verification only. No Render service, production database role,
production migration, production monitoring, restart behavior, or rollback
has been deployed or operationally verified.

## Identity and session deployment

The API must use a secret-managed, non-owner `NOBYPASSRLS` database role. Do not use the migration owner or development seed role. Apply reviewed identity and branch-context migrations before starting the API, which requires `DATABASE_URL`. Grant only required access, including `SELECT` on branch and branch-assignment records; do not grant schema management, table ownership, `SUPERUSER`, or `BYPASSRLS`.

Organization context requires a current active membership and `ACTIVE` organization lifecycle. Branch context additionally requires an active branch in that organization and either explicit branch assignment or a trusted `ALL` membership access mode. Middleware revalidates stored organization and branch context on each request; stale scope is cleared. Organization changes clear the selected branch atomically. Full branch-level filters for business records and RBAC remain deferred, so do not expose business routes before those checks are implemented.

Terminate TLS at an approved HTTPS ingress and use `Secure` session cookies in production. Set the exact browser origins in `AUTH_ALLOWED_ORIGINS`; do not use wildcard CORS or broad origin patterns. The cookie is host-only, `HttpOnly`, `SameSite=Lax`, and `Path=/`; frontend applications must use same-site/same-origin routing or an explicitly reviewed deployment design.

The API login limiter uses PostgreSQL atomic counters and forced RLS so API replicas sharing the database coordinate limits. A database outage fails login throttling closed; this is not volumetric edge protection. Define account recovery/lockout operations and monitoring before production; no self-service reset or administrator unlock API exists yet.

## Repository governance

Expected branches are `main`, `develop`, `feature/*`, `bugfix/*`, `hotfix/*`, and `release/*`. Administrators should protect `main` and `develop`, require pull requests and reviews, require CI/security checks, disallow force pushes, and retain an audit trail. Configure CODEOWNERS once the GitHub organization/team handles are confirmed; no owner handle was supplied, so the repository does not invent one.

Before production automation is added, document environments, approval gates, artifact provenance, migrations, secret access, health checks, rollback, backups, and restore verification. Staging and production workflows must reflect real provisioned infrastructure rather than placeholder deployments.
