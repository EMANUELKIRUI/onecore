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
    'core.organization.membership_branch.read',
    'core.organization',
    'membership_branch',
    'read',
    'Read membership branch assignments.',
    'ACTIVE',
    true
  ),
  (
    'core.organization.membership_branch.assign',
    'core.organization',
    'membership_branch',
    'assign',
    'Assign active branches to organization memberships.',
    'ACTIVE',
    true
  ),
  (
    'core.organization.membership_branch.remove',
    'core.organization',
    'membership_branch',
    'remove',
    'Remove branch assignments from organization memberships.',
    'ACTIVE',
    true
  )
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN
    SELECT DISTINCT "organization_id"
    FROM "roles"
    WHERE "is_system" = true
      AND "name" IN ('Organization Owner', 'Organization Admin')
  LOOP
    PERFORM set_config(
      'app.current_organization_id',
      tenant."organization_id"::text,
      true
    );
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
        'core.organization.membership_branch.read',
        'core.organization.membership_branch.assign',
        'core.organization.membership_branch.remove'
      )
    WHERE "roles"."organization_id" = tenant."organization_id"
      AND "roles"."is_system" = true
      AND "roles"."name" IN ('Organization Owner', 'Organization Admin')
    ON CONFLICT ("organization_id", "role_id", "permission_id") DO NOTHING;
  END LOOP;
END;
$$;
--> statement-breakpoint

GRANT INSERT ("organization_id", "membership_id", "branch_id")
  ON "membership_branches" TO onecore_app;
--> statement-breakpoint
GRANT DELETE ON "membership_branches" TO onecore_app;