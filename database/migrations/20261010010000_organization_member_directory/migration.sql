CREATE POLICY "users_organization_directory_read" ON "users"
FOR SELECT
USING (
  nullif(current_setting('app.current_user_directory_organization_id', true), '')::uuid =
    nullif(current_setting('app.current_organization_id', true), '')::uuid
  AND EXISTS (
    SELECT 1
    FROM "organization_memberships" AS "directory_membership"
    WHERE "directory_membership"."organization_id" =
      nullif(current_setting('app.current_organization_id', true), '')::uuid
      AND "directory_membership"."user_id" = "users"."id"
  )
);
