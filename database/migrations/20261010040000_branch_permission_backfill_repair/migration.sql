DO $$
DECLARE
  tenant_id uuid;
  target_role record;
  permission_row record;
BEGIN
  FOR tenant_id IN
    SELECT DISTINCT "organization_id"
    FROM "roles"
    WHERE "is_system" = true
      AND "name" IN ('Organization Owner', 'Organization Admin')
  LOOP
    PERFORM set_config('app.current_organization_id', tenant_id::text, true);

    FOR target_role IN
      SELECT "id", "name"
      FROM "roles"
      WHERE "organization_id" = tenant_id
        AND "is_system" = true
        AND "name" IN ('Organization Owner', 'Organization Admin')
    LOOP
      FOR permission_row IN
        SELECT "id", "key"
        FROM "permissions"
        WHERE "key" IN (
          'core.organization.branch.read',
          'core.organization.branch.create',
          'core.organization.branch.update',
          'core.organization.membership_branch.read',
          'core.organization.membership_branch.assign',
          'core.organization.membership_branch.remove'
        )
      LOOP
        INSERT INTO "role_permissions" (
          "organization_id",
          "role_id",
          "permission_id",
          "scope_type",
          "scope"
        )
        SELECT
          tenant_id,
          target_role."id",
          permission_row."id",
          'ORGANIZATION',
          '{}'::jsonb
        WHERE NOT EXISTS (
          SELECT 1
          FROM "role_permissions" AS existing
          WHERE existing."organization_id" = tenant_id
            AND existing."role_id" = target_role."id"
            AND existing."permission_id" = permission_row."id"
        )
        ON CONFLICT ("organization_id", "role_id", "permission_id") DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;

  PERFORM set_config('app.current_organization_id', '', true);
END $$;
