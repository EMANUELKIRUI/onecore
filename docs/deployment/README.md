# Deployment and governance

Phase 2 adds a production-database migration boundary but does not provision production infrastructure or deploy applications. No hosting provider, database environment, release workflow, backup schedule, or production network has been confirmed; the repository does not invent one.

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

The current API health route remains liveness-only. Do not report it as database readiness. No production migration/deploy/rollback workflow exists yet.

## Identity and session deployment

The API must use a secret-managed, non-owner `NOBYPASSRLS` database role. Do not use the migration owner or development seed role. Apply reviewed identity and branch-context migrations before starting the API, which requires `DATABASE_URL`. Grant only required access, including `SELECT` on branch and branch-assignment records; do not grant schema management, table ownership, `SUPERUSER`, or `BYPASSRLS`.

Organization context requires a current active membership and `ACTIVE` organization lifecycle. Branch context additionally requires an active branch in that organization and either explicit branch assignment or a trusted `ALL` membership access mode. Middleware revalidates stored organization and branch context on each request; stale scope is cleared. Organization changes clear the selected branch atomically. Full branch-level filters for business records and RBAC remain deferred, so do not expose business routes before those checks are implemented.

Terminate TLS at an approved HTTPS ingress and use `Secure` session cookies in production. Set the exact browser origins in `AUTH_ALLOWED_ORIGINS`; do not use wildcard CORS or broad origin patterns. The cookie is host-only, `HttpOnly`, `SameSite=Lax`, and `Path=/`; frontend applications must use same-site/same-origin routing or an explicitly reviewed deployment design.

The default login limiter uses process memory and is not coordinated across API replicas. Before horizontal scaling, configure a shared rate-limit store or enforce a suitable limit at a trusted edge. Define account recovery/lockout operations and monitoring before production; no self-service reset or administrator unlock API exists yet.

## Repository governance

Expected branches are `main`, `develop`, `feature/*`, `bugfix/*`, `hotfix/*`, and `release/*`. Administrators should protect `main` and `develop`, require pull requests and reviews, require CI/security checks, disallow force pushes, and retain an audit trail. Configure CODEOWNERS once the GitHub organization/team handles are confirmed; no owner handle was supplied, so the repository does not invent one.

Before production automation is added, document environments, approval gates, artifact provenance, migrations, secret access, health checks, rollback, backups, and restore verification. Staging and production workflows must reflect real provisioned infrastructure rather than placeholder deployments.
