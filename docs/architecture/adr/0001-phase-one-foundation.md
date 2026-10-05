# ADR 0001: Phase 1 engineering foundation

- **Status:** Accepted for Phase 1
- **Date:** 2026-10-05

## Context

The product specification requires a secure, modular, multi-tenant platform but does not mandate a programming language, package manager, HTTP framework, or database. Phase 1 should establish executable engineering conventions without pretending later security or business capabilities exist.

## Decisions

- Use Node.js 24 and TypeScript with strict compiler options for a single language across server and future applications.
- Use npm workspaces and the npm lockfile for package boundaries and reproducible dependency installation. Defer a task-graph tool until parallel build scale justifies it.
- Use Fastify 5 for the API service because it provides a small, plugin-oriented HTTP boundary without coupling domain code to a web framework.
- Use Zod for runtime environment validation and Pino for structured logging. The shared config package redacts common secret-bearing fields.
- Use Vitest for focused TypeScript tests, ESLint with typescript-eslint for static analysis, and Prettier for formatting.
- Use shared contracts as the API seam; keep HTTP transport concerns in `services/api` and avoid direct application-to-database access.
- Defer database-engine and migration-tool selection to Phase 2, authentication to Phase 3, and tenant isolation to Phase 4. No production deployment workflow is added until infrastructure exists.

## Consequences

The stack is straightforward to bootstrap and supports a modular monolith. npm scripts currently orchestrate package build order explicitly. A future task runner can replace that once build/test fan-out warrants it. Security-sensitive capabilities remain unavailable until their owning phases implement and test them.
