# Test strategy

Foundation unit tests live beside their owning packages. The database package applies every checked-in migration to a fresh PGlite PostgreSQL-compatible instance and verifies RLS, tenant-safe relationships, memberships, branch scope assignments, module/feature/flag separation, custom fields, workflow activation, audit immutability, and database constraints. `npm test` runs these with the other package tests. Authentication, full authorization, production PostgreSQL deployment, backup/restore, end-to-end, accessibility, and performance suites remain future work.
