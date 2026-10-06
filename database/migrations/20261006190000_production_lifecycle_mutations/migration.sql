GRANT INSERT ("id", "name", "slug", "industry", "status", "deployment_type")
  ON "organizations" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("status") ON "organizations" TO onecore_app;
--> statement-breakpoint
CREATE POLICY "organizations_platform_superadmin_insert"
ON "organizations"
AS RESTRICTIVE
FOR INSERT
TO onecore_app
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "platform_user_roles"
    WHERE "platform_user_roles"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND "platform_user_roles"."role" = 'SUPERADMIN'
  )
);
--> statement-breakpoint
GRANT INSERT ("id", "email", "display_name", "status", "password_hash")
  ON "users" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("id", "organization_id", "user_id", "status", "branch_access_mode")
  ON "organization_memberships" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("is_system") ON "roles" TO onecore_app;
--> statement-breakpoint
CREATE POLICY "roles_system_templates_platform_provisioning"
ON "roles"
AS RESTRICTIVE
FOR INSERT
TO onecore_app
WITH CHECK (
  NOT "is_system"
  OR (
    "name" IN (
      'Organization Owner',
      'Organization Admin',
      'Manager',
      'Staff',
      'Viewer'
    )
    AND EXISTS (
      SELECT 1
      FROM "platform_user_roles"
      WHERE "platform_user_roles"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND "platform_user_roles"."role" = 'SUPERADMIN'
    )
  )
);
--> statement-breakpoint
GRANT INSERT (
  "id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "organization_id",
  "branch_id",
  "actor_user_id",
  "correlation_id",
  "causation_id",
  "occurred_at",
  "payload",
  "metadata",
  "version",
  "delivery_status",
  "next_attempt_at"
) ON "outbox_events" TO onecore_app;