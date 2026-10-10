INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system")
VALUES
  ('core.organization.branch.read', 'core.organization', 'branch', 'read', 'Read organization branches.', 'ACTIVE', true),
  ('core.organization.branch.create', 'core.organization', 'branch', 'create', 'Create organization branches.', 'ACTIVE', true),
  ('core.organization.branch.update', 'core.organization', 'branch', 'update', 'Update and activate or deactivate organization branches.', 'ACTIVE', true)
ON CONFLICT ("module_key", "resource_key", "action_key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "status" = 'ACTIVE';
--> statement-breakpoint
INSERT INTO "module_permissions" ("module_id", "permission_id")
SELECT "modules"."id", "permissions"."id"
FROM "modules" CROSS JOIN "permissions"
WHERE "modules"."key" = 'core.organization'
  AND "permissions"."key" IN (
    'core.organization.branch.read',
    'core.organization.branch.create',
    'core.organization.branch.update'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE
  tenant_id uuid;
BEGIN
  FOR tenant_id IN
    SELECT DISTINCT "organization_id"
    FROM "roles"
    WHERE "status" = 'ACTIVE'
      AND "name" IN (
        'Organization Owner', 'Organization Admin', 'Manager', 'Staff', 'Viewer'
      )
  LOOP
    PERFORM set_config('app.current_organization_id', tenant_id::text, true);

    INSERT INTO "role_permissions" (
      "organization_id", "role_id", "permission_id"
    )
    SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
    FROM "roles" CROSS JOIN "permissions"
    WHERE "roles"."organization_id" = tenant_id
      AND "roles"."status" = 'ACTIVE'
      AND "roles"."name" IN ('Organization Owner', 'Organization Admin')
      AND "permissions"."key" IN (
        'core.organization.branch.read',
        'core.organization.branch.create',
        'core.organization.branch.update'
      )
    ON CONFLICT DO NOTHING;

    INSERT INTO "role_permissions" (
      "organization_id", "role_id", "permission_id"
    )
    SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
    FROM "roles" CROSS JOIN "permissions"
    WHERE "roles"."organization_id" = tenant_id
      AND "roles"."status" = 'ACTIVE'
      AND "roles"."name" IN ('Manager', 'Staff', 'Viewer')
      AND "permissions"."key" = 'core.organization.branch.read'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;
--> statement-breakpoint
GRANT INSERT (
  "id", "organization_id", "name", "code", "status", "address",
  "created_at", "updated_at"
)
  ON "branches" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("name", "code", "address", "status", "updated_at")
  ON "branches" TO onecore_app;