# Database migrations

PostgreSQL 16+ and Drizzle Kit are selected for Phase 2; see [ADR 0002](../../docs/architecture/adr/0002-postgresql-drizzle-persistence.md). PostgreSQL 18.6 live migration and RLS validation completed on 2026-10-05. Drizzle schema source is in `../schema/`; generated, reviewed SQL migrations and Drizzle snapshots/journal are stored here.

Run `npm run db:generate` to generate a migration and `npm run db:migrate` to apply committed SQL using a `DATABASE_URL` for `onecore_migrator`. This role requires database `CREATE` for Drizzle's migration metadata schema and `USAGE, CREATE` on `public`; the API must use `onecore_app`, which is neither a table owner nor `BYPASSRLS`. npm does not load `.env` automatically, so export the appropriate role-specific URL before each command. Never use schema push or manually edit a production database. Migrations are forward-only; recover through a compensating migration or verified backup restore.

Schema changes follow **expand → migrate → verify → contract**. Destructive contract steps require explicit review after deployed readers and writers no longer depend on the old schema. Tenant scoping is enforced in trusted server-side query boundaries and by PostgreSQL RLS; application connections must not own protected tables or bypass RLS.

Phase 5 reuses the existing RBAC tables. Its migration adds canonical
structured permission fields, role and permission lifecycle, data scope on
role grants, and reusable permission catalog entries. Roles, role grants,
membership-role assignments, and membership data scopes remain organization
scoped with the existing composite foreign keys and forced RLS. Apply through
the migration role, then provision the runtime role's least-privilege RBAC
access (these statements are additive to the identity, branch, and audit
grants already required by the API):

```sql
GRANT SELECT, INSERT, UPDATE ON public.roles TO onecore_app;
GRANT SELECT, INSERT, DELETE ON public.role_permissions TO onecore_app;
GRANT SELECT, INSERT, DELETE ON public.membership_roles TO onecore_app;
GRANT SELECT ON public.permissions, public.membership_data_scopes,
  public.modules, public.organization_modules, public.platform_user_roles
  TO onecore_app;
```

The permission catalog is global and read-only to the API. Never make
`onecore_app` an owner or grant it `BYPASSRLS`.
See [RBAC security documentation](../../docs/security/rbac.md).

Phase 4 adds a typed branch lifecycle, fail-closed membership branch-access mode, and a session branch ID constrained to the selected organization. The branch status migration normalizes existing status casing and rejects values outside the typed lifecycle; review existing production branch status values before applying it.
