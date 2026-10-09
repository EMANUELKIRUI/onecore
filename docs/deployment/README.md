# Deployment and governance

Phase 2 adds a production-database migration boundary. Hosting and release procedures remain deployment-specific; this guide documents the runtime configuration contract without provisioning infrastructure.

## Runtime environment

The API validates environment variables at startup through `@onecore/config`. `NODE_ENV` must be exactly one of `development`, `test`, `staging`, or `production`; production is explicitly supported, and other values are rejected. The `.env.example` file uses `development` for local work. Staging/production or a supplied `PORT` defaults the listener to `0.0.0.0`; local development retains `127.0.0.1`. The port uses `process.env.PORT` when provided and otherwise defaults to `3000`. Set `NODE_ENV=production` for a production service and provide Render's assigned `PORT` and PostgreSQL `DATABASE_URL`. The API's checked-in Render service uses `npm ci && npm run build` and `npm start`; automatic deploy is disabled. `AUTH_ALLOWED_ORIGINS` must contain the exact comma-separated browser origins when cross-origin browser requests are supported; the current frontend contract uses same-origin routing.

## Static frontend deployment

Marketing, Business, Superadmin, and Support are separate native static HTML, CSS, and ES-module applications. Each Vercel project uses its corresponding `apps/<name>` Root Directory, runs the checked-in build command, and publishes `dist`. Enable Vercel's **Include files outside the Root Directory** setting so the build can read `scripts/build-static-app.mjs` and `packages/ui`; the build copies the required shared stylesheet and modules into each app output. No bundler or external frontend dependency is required. Superadmin provides the existing organization application review API; Support has no connected support API and displays an unavailable state without customer data.

Set `ONECORE_BUSINESS_URL` on Marketing and `ONECORE_MARKETING_URL` on Business, Superadmin, and Support to the corresponding public app URLs; each Vercel build fails if its required cross-app URL is missing. The static build injects these values into cross-app links. `ONECORE_API_BASE_PATH` may set a same-origin API path prefix such as `/api`; the current API client intentionally rejects cross-origin URLs and sends same-origin cookies. Route that prefix through a reviewed same-origin proxy to the Render API. These values are public URL/path configuration only; never put credentials or service secrets in frontend build variables.

## Organization deployment types

`SAAS`, `CUSTOM`, `DEDICATED`, and `ENTERPRISE` are persisted domain values on an organization and are available to future provisioning, billing, support, and deployment services. They are not yet a provisioning implementation:

- **SAAS:** intended shared OneCore service and database with strict organization isolation.
- **CUSTOM:** organization-specific configuration/branding/workflow/approved extensions on the shared platform contract; not a copied codebase or customer branch.
- **DEDICATED:** intended isolated deployment resources for an organization, provisioned through common automation and compatible platform releases.
- **ENTERPRISE:** contractual service tier that may combine dedicated resources, plan/entitlement policy, support, and approved extensions; not a separate code fork.

The exact infrastructure placement, residency, service levels, tenancy model for each deployment, and enterprise contract rules remain product/operations decisions. Do not infer them from the enum alone or scatter deployment-specific conditionals across modules.

## Database deployment

Use separate secret-managed credentials for schema migrations and application runtime. The migration principal owns/provisions the schema; the application principal must be a non-owner with `NOBYPASSRLS` and least-privilege grants. Configure TLS and network allowlists for the selected managed PostgreSQL service.

Before a release, back up the target database, review and apply the committed migration with the approved migration job, verify schema and application health, and monitor. Use expand → migrate → verify → contract. A failed/unsafe change requires a forward repair or a tested backup restore; do not assume automatic migration rollback. Validate backups and restores against the actual production provider before launch.

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
2. Apply the worker-discovery migration through the approved migration process
   after reviewing the target, backup, and migration diff. Do not apply it from
   the worker or API startup path.
3. Provision a dedicated login and grant it membership only in the
   `onecore_worker` `NOLOGIN NOSUPERUSER NOBYPASSRLS` group role. Do not reuse
   the API or migrator login. Configure the service's secret `DATABASE_URL`
   with that login, and set `LOG_LEVEL` plus optional worker tuning variables.
   Never place credentials in the blueprint or source control.
4. Start the background worker separately from the API. Verify a
   `worker.ready` log, successful poll events, and tenant-authorized queue
   outcomes before considering it operational.

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
operator investigation. Queue status must be inspected through the existing
authorized tenant-scoped APIs, not by granting workers global queue access.

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
