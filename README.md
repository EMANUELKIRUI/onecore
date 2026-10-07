# OneCore Business OS

**One Platform. Every Organization. Anywhere.**

OneCore Business OS is enterprise software for modern African organizations, built by OneCore Technologies Ltd. This repository contains the engineering, PostgreSQL tenant-persistence, identity/authentication, and organization/branch tenant-isolation foundations. It does not yet implement business modules or production infrastructure.

## Requirements

- Node.js 24 or later
- npm 11 or later

## Getting started

```sh
npm ci
npm run check
```

The API requires PostgreSQL and the `DATABASE_URL` for a non-owner `NOBYPASSRLS` application role. Provision the database and run migrations using the [database guide](database/README.md) before starting `npm run dev`. The API listens on `http://127.0.0.1:3000` by default. `GET /health` is a process liveness endpoint; it does not indicate database or downstream-service readiness.

`.env.example` documents supported environment variables; npm scripts do not automatically load `.env`, so export local values in your shell. Replace all placeholders and never reuse local credentials outside development.

## Workspace

- `apps/` reserves the Marketing, Business, Superadmin, Support, and Status applications.
- `services/api/` contains the HTTP service boundary.
- `packages/` contains reusable contracts, configuration, and platform domain values.
- `modules/` is reserved for independently structured business modules.
- `database/` owns PostgreSQL schema, migrations, tenant-aware repositories, seed data, and persistence tests.
- `packages/ui/` provides the shared dependency-free design tokens, API client, and frontend helpers; `apps/marketing/` and `apps/business/` contain the initial static application shells.
- `docs/` contains architecture, security, development, API, module, and deployment guidance.

See [the architecture overview](docs/architecture/overview.md), [frontend foundation](docs/frontend/design-system.md), [database guide](database/README.md), [development guide](docs/development/README.md), and [architecture decisions](docs/architecture/adr/).

## Local database

Install PostgreSQL 16+, create a local development database, set `DATABASE_URL`, then run:

```sh
npm run db:migrate
ONECORE_ALLOW_DEMO_SEED=YES npm run db:seed
npm run dev
```

The seed requires the explicit `ONECORE_ALLOW_DEMO_SEED=YES` opt-in and refuses `NODE_ENV=production`. To create development login credentials, set `ONECORE_DEMO_PASSWORD` to a local-only password of at least 16 characters before running the seed. Seeded identities have no password if this variable is absent. Database integration tests use a clean in-memory PostgreSQL-compatible instance. The API `/health` endpoint remains a process-liveness check.

## Quality checks

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

Phase boundaries and known limitations are documented in [the deployment and governance guide](docs/deployment/README.md).
