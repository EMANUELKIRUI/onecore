DO $$
DECLARE
  tenant_id uuid;
  target_role record;
  permission_row record;
  inserted_permission_id uuid;
BEGIN
  FOR tenant_id IN
    SELECT DISTINCT "organization_id"
    FROM "roles"
    WHERE "name" IN ('Organization Owner', 'Organization Admin')
      AND "is_system" = true
  LOOP
    PERFORM set_config('app.current_organization_id', tenant_id::text, true);
    FOR target_role IN
      SELECT "id", "name"
      FROM "roles"
      WHERE "organization_id" = tenant_id
        AND "name" IN ('Organization Owner', 'Organization Admin')
        AND "is_system" = true
    LOOP
      FOR permission_row IN
        SELECT "id", "key"
        FROM "permissions"
        WHERE "key" LIKE 'core.organization.%'
          AND "resource_key" IN (
            'features',
            'custom_fields',
            'workflows',
            'notifications',
            'integrations',
            'domains'
          )
      LOOP
        INSERT INTO "role_permissions" (
          "organization_id",
          "role_id",
          "permission_id",
          "scope_type",
          "scope"
        )
        VALUES (
          tenant_id,
          target_role."id",
          permission_row."id",
          'ORGANIZATION',
          '{}'::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING "permission_id" INTO inserted_permission_id;
        IF FOUND THEN
          INSERT INTO "audit_logs" (
            "organization_id",
            "action",
            "resource",
            "resource_id",
            "result",
            "request_metadata"
          )
          VALUES (
            tenant_id,
            'ROLE_PERMISSION_GRANTED',
            'role_permission',
            target_role."id"::text || ':' || inserted_permission_id::text,
            'SUCCESS',
            jsonb_build_object(
              'source', 'phase_7_existing_default_role_backfill',
              'roleName', target_role."name",
              'permissionKey', permission_row."key"
            )
          );
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;
