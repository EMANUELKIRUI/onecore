# Development

Use Node.js 24+ and npm 11+. Run `npm ci` after checkout, then `npm run check` before opening a pull request. The API needs a local PostgreSQL database migrated with `npm run db:migrate` and a non-owner, `NOBYPASSRLS` `DATABASE_URL`. npm scripts do not automatically load `.env`; export variables in the shell. Then `npm run dev` starts the API after building its shared workspace dependencies.

For fictional development identities, run the database seed as documented in the [database guide](../../database/README.md), with the explicit `ONECORE_ALLOW_DEMO_SEED=YES` local-database opt-in. Set a local-only `ONECORE_DEMO_PASSWORD` (16 or more characters) before seeding if login credentials are needed. The seed refuses `NODE_ENV=production`; it never prints the supplied password. Without that variable, the identities are created without credentials.

Authentication uses Argon2id, HTTP-only opaque cookie sessions, configurable
origin and session settings, a default 5-per-minute per-IP login limit, and
account lockout after 10 failures in 15 minutes. The API server uses the
PostgreSQL-backed limiter for shared limits; production login fails closed if
that limiter is not configured. See [ADR 0004](../architecture/adr/0004-opaque-server-side-authentication-sessions.md) for session design, [ADR 0010](../architecture/adr/0010-observability-and-rate-limiting.md) for shared rate limiting, and the [authentication threat model](../security/authentication.md).

Tenant requests must derive organization and optional branch context from the live authenticated session. Organization selection requires an active membership and active organization; branch selection requires an active branch plus assigned access or explicit organization-wide branch scope. Use `withActiveOrganizationTransaction` or `withActiveBranchTransaction` from `@onecore/database`; the lower-level organization transaction helper is not exported as an authorization API. Branch scope does not implement RBAC or filter any future business table automatically. See [ADR 0005](../architecture/adr/0005-organization-and-branch-context.md).

TypeScript packages use strict settings from `tsconfig.base.json`. Keep source in `src/`, tests beside their owning package, and exported package interfaces intentional. Do not commit build output, local environment files, credentials, or generated dependency directories.

The expected flow is `feature/*` or `bugfix/*` from `develop`, reviewed pull requests into `develop`, then release branches into protected `main`; urgent fixes use `hotfix/*`. The actual GitHub branch protections and team ownership must be configured by repository administrators.
