GRANT INSERT ON "organizations" TO onecore_app;
--> statement-breakpoint
DROP POLICY "organizations_platform_superadmin_insert" ON "organizations";
--> statement-breakpoint
CREATE POLICY "organizations_platform_superadmin_or_application_insert"
ON "organizations"
AS RESTRICTIVE
FOR INSERT
TO onecore_app
WITH CHECK (
  (
    EXISTS (
      SELECT 1
      FROM "platform_user_roles"
      WHERE "platform_user_roles"."user_id" =
        nullif(current_setting('app.current_user_id', true), '')::uuid
        AND "platform_user_roles"."role" = 'SUPERADMIN'
    )
  )
  OR (
    "status" = 'PENDING'
    AND current_setting('app.organization_application_submission', true) = 'true'
    AND "profile"->'application' IS NOT NULL
  )
);
--> statement-breakpoint
CREATE POLICY "organizations_platform_superadmin_read"
ON "organizations"
FOR SELECT
TO onecore_app
USING (
  EXISTS (
    SELECT 1
    FROM "platform_user_roles"
    WHERE "platform_user_roles"."user_id" =
      nullif(current_setting('app.current_user_id', true), '')::uuid
      AND "platform_user_roles"."role" = 'SUPERADMIN'
  )
);
--> statement-breakpoint
CREATE POLICY "organizations_application_duplicate_check"
ON "organizations"
FOR SELECT
TO onecore_app
USING (
  (
    "slug" = current_setting('app.organization_application_slug', true)
  )
  OR (
    lower("profile"->'application'->>'ownerEmail') =
      current_setting('app.organization_application_owner_email', true)
    AND "status" IN (
      'PENDING',
      'UNDER_REVIEW',
      'APPROVED',
      'PAYMENT_PENDING',
      'ACTIVE'
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_application_owner_email_unique"
ON "organizations" (lower("profile"->'application'->>'ownerEmail'))
WHERE "profile" ? 'application'
  AND "status" IN ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'PAYMENT_PENDING', 'ACTIVE');
