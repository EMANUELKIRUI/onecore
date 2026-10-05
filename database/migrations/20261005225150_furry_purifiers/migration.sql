CREATE TYPE "module_lifecycle" AS ENUM('DEVELOPMENT', 'INTERNAL_TESTING', 'QA', 'SECURITY_REVIEW', 'STAGING', 'UAT', 'SUPERADMIN_REVIEW', 'APPROVED', 'AVAILABLE', 'DEPRECATED', 'RETIRED');--> statement-breakpoint
ALTER TYPE "organization_module_status" ADD VALUE 'REQUESTED' BEFORE 'AVAILABLE';--> statement-breakpoint
ALTER TYPE "organization_module_status" ADD VALUE 'PENDING' BEFORE 'AVAILABLE';--> statement-breakpoint
ALTER TYPE "organization_module_status" ADD VALUE 'APPROVED' BEFORE 'AVAILABLE';--> statement-breakpoint
ALTER TYPE "organization_module_status" ADD VALUE 'EXPIRED';--> statement-breakpoint
ALTER TABLE "modules" ADD COLUMN "lifecycle" "module_lifecycle" DEFAULT 'DEVELOPMENT'::"module_lifecycle" NOT NULL;--> statement-breakpoint
CREATE INDEX "module_dependencies_dependency_idx" ON "module_dependencies" ("dependency_module_id");--> statement-breakpoint
CREATE INDEX "module_permissions_permission_idx" ON "module_permissions" ("permission_id");--> statement-breakpoint
CREATE INDEX "modules_lifecycle_available_idx" ON "modules" ("lifecycle","is_available");--> statement-breakpoint
CREATE INDEX "plan_modules_module_idx" ON "plan_modules" ("module_id");--> statement-breakpoint
ALTER TABLE "module_dependencies" ADD CONSTRAINT "module_dependencies_no_self_reference" CHECK ("module_id" <> "dependency_module_id");
--> statement-breakpoint
UPDATE "modules"
SET "lifecycle" = CASE
  WHEN "is_available" THEN 'AVAILABLE'::"module_lifecycle"
  ELSE 'DEVELOPMENT'::"module_lifecycle"
END;
--> statement-breakpoint
INSERT INTO "module_versions" ("module_id", "version", "status", "manifest")
SELECT
  module."id",
  '1.0.0',
  module."lifecycle"::text,
  jsonb_build_object(
    'name', module."key",
    'version', '1.0.0',
    'displayName', module."name",
    'dependencies', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('moduleName', dependency."key") ||
        CASE
          WHEN module_dependency."minimum_version" IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('minimumVersion', module_dependency."minimum_version")
        END
      )
      FROM "module_dependencies" module_dependency
      JOIN "modules" dependency
        ON dependency."id" = module_dependency."dependency_module_id"
      WHERE module_dependency."module_id" = module."id"
    ), '[]'::jsonb),
    'permissions', COALESCE((
      SELECT jsonb_agg(permission."key" ORDER BY permission."key")
      FROM "module_permissions" module_permission
      JOIN "permissions" permission
        ON permission."id" = module_permission."permission_id"
      WHERE module_permission."module_id" = module."id"
    ), '[]'::jsonb),
    'features', COALESCE((
      SELECT jsonb_agg(feature."key" ORDER BY feature."key")
      FROM "features" feature
      WHERE feature."module_id" = module."id"
    ), '[]'::jsonb),
    'lifecycle', module."lifecycle"::text
  ) ||
  CASE
    WHEN module."description" IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('description', module."description")
  END
FROM "modules" module
WHERE NOT EXISTS (
  SELECT 1 FROM "module_versions" version
  WHERE version."module_id" = module."id"
);
--> statement-breakpoint
INSERT INTO "permissions"
  ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system")
VALUES
  ('core.modules.module.read', 'core.modules', 'module', 'read', 'Read registered modules and organization availability.', 'ACTIVE', true),
  ('core.modules.entitlement.read', 'core.modules', 'entitlement', 'read', 'Read organization module entitlements.', 'ACTIVE', true),
  ('core.modules.entitlement.request', 'core.modules', 'entitlement', 'request', 'Request an available module for the organization.', 'ACTIVE', true),
  ('core.modules.entitlement.manage', 'core.modules', 'entitlement', 'manage', 'Enable or disable organization module entitlements.', 'ACTIVE', true)
ON CONFLICT ("module_key", "resource_key", "action_key") DO NOTHING;
--> statement-breakpoint
CREATE POLICY "audit_logs_module_registry_platform_insert"
ON "audit_logs"
FOR INSERT
WITH CHECK (
  "organization_id" IS NULL
  AND "resource" = 'module_registry'
  AND current_user = 'onecore_migrator'
);
--> statement-breakpoint
GRANT SELECT ON "modules", "module_versions", "module_dependencies",
  "module_permissions", "features", "plans", "plan_modules",
  "subscriptions", "subscription_items" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "organization_modules" TO onecore_app;