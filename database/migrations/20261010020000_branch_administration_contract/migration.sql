INSERT INTO "permissions" (
  "key",
  "module_key",
  "resource_key",
  "action_key",
  "description",
  "status",
  "is_system"
)
VALUES
  (
    'core.organization.branch.read',
    'core.organization',
    'branch',
    'read',
    'Read organization branch details.',
    'ACTIVE',
    true
  ),
  (
    'core.organization.branch.create',
    'core.organization',
    'branch',
    'create',
    'Create organization branches.',
    'ACTIVE',
    true
  ),
  (
    'core.organization.branch.update',
    'core.organization',
    'branch',
    'update',
    'Update and activate or deactivate organization branches.',
    'ACTIVE',
    true
  )
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE
  tenant_id uuid;
BEGIN
  FOR tenant_id IN
    SELECT DISTINCT "organization_id"
    FROM "roles"
    WHERE "is_system" = true
      AND "name" IN ('Organization Owner', 'Organization Admin')
  LOOP
    PERFORM set_config('app.current_organization_id', tenant_id::text, true);

    INSERT INTO "role_permissions" (
      "organization_id",
      "role_id",
      "permission_id",
      "scope_type",
      "scope"
    )
    SELECT
      "roles"."organization_id",
      "roles"."id",
      "permissions"."id",
      'ORGANIZATION',
      '{}'::jsonb
    FROM "roles"
    JOIN "permissions"
      ON "permissions"."key" IN (
        'core.organization.branch.read',
        'core.organization.branch.create',
        'core.organization.branch.update'
      )
    WHERE "roles"."organization_id" = tenant_id
      AND "roles"."is_system" = true
      AND "roles"."name" IN ('Organization Owner', 'Organization Admin')
    ON CONFLICT ("organization_id", "role_id", "permission_id") DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_organization_id', '', true);
END $$;
--> statement-breakpoint

GRANT INSERT ("organization_id", "name", "code")
  ON "branches" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("name", "code", "status", "updated_at")
  ON "branches" TO onecore_app;
