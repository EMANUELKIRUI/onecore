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
WHERE "roles"."is_system" = true
  AND "roles"."name" IN ('Organization Owner', 'Organization Admin')
ON CONFLICT ("organization_id", "role_id", "permission_id") DO NOTHING;
--> statement-breakpoint

GRANT INSERT ("organization_id", "name", "code")
  ON "branches" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("name", "code", "status", "updated_at")
  ON "branches" TO onecore_app;
