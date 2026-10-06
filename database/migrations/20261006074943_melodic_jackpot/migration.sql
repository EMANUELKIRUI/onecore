CREATE TYPE "custom_field_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "feature_flag_type" AS ENUM('BOOLEAN', 'STRING', 'NUMBER', 'JSON');--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "default_value" jsonb;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "is_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "status" "custom_field_status" DEFAULT 'ACTIVE'::"custom_field_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD COLUMN "scope_key" varchar(20) DEFAULT 'ORGANIZATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD COLUMN "value" jsonb;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN "value_type" "feature_flag_type" DEFAULT 'BOOLEAN'::"feature_flag_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN "default_value" jsonb DEFAULT 'false' NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN "is_security_sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "feature_flags" SET "default_value" = to_jsonb("default_enabled") WHERE "value_type" = 'BOOLEAN';--> statement-breakpoint
UPDATE "feature_flag_assignments" SET "scope_key" = "scope"::text;--> statement-breakpoint
UPDATE "feature_flag_assignments" SET "value" = to_jsonb("enabled") WHERE "value" IS NULL;--> statement-breakpoint
DROP INDEX "feature_flag_assignments_lookup_idx";--> statement-breakpoint
CREATE INDEX "feature_flag_assignments_lookup_idx" ON "feature_flag_assignments" ("flag_id","scope_key","organization_id","branch_id","user_id");--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" DROP CONSTRAINT "feature_flag_assignments_scope_unique";--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD CONSTRAINT "feature_flag_assignments_scope_unique" UNIQUE NULLS NOT DISTINCT("flag_id","scope_key","environment","module_id","organization_id","branch_id","user_id");--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD CONSTRAINT "feature_flag_assignments_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_sort_order_nonnegative" CHECK ("sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD CONSTRAINT "feature_flag_assignments_scope_key_check" CHECK (("scope_key" in ('SYSTEM', 'PLATFORM', 'GLOBAL') and "environment" is null and "module_id" is null and "organization_id" is null and "branch_id" is null and "user_id" is null)
        or ("scope_key" = 'ENVIRONMENT' and "environment" is not null and "module_id" is null and "organization_id" is null and "branch_id" is null and "user_id" is null)
        or ("scope_key" = 'MODULE' and "environment" is null and "module_id" is not null and "organization_id" is null and "branch_id" is null and "user_id" is null)
        or ("scope_key" = 'ORGANIZATION' and "environment" is null and "module_id" is null and "organization_id" is not null and "branch_id" is null and "user_id" is null)
        or ("scope_key" = 'BRANCH' and "environment" is null and "module_id" is null and "organization_id" is not null and "branch_id" is not null and "user_id" is null)
        or ("scope_key" = 'USER' and "environment" is null and "module_id" is null and "organization_id" is not null and "branch_id" is null and "user_id" is not null));--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_default_value_type_check" CHECK (("value_type" = 'BOOLEAN' and jsonb_typeof("default_value") = 'boolean')
        or ("value_type" = 'STRING' and jsonb_typeof("default_value") = 'string')
        or ("value_type" = 'NUMBER' and jsonb_typeof("default_value") = 'number')
        or "value_type" = 'JSON');--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_security_boolean_check" CHECK (not "is_security_sensitive" or ("value_type" = 'BOOLEAN' and "default_value" = 'false'::jsonb));
--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system") VALUES
('core.organization.features.read', 'core.organization', 'features', 'read', 'Read organization feature assignments.', 'ACTIVE', true),
('core.organization.features.update', 'core.organization', 'features', 'update', 'Update organization feature assignments.', 'ACTIVE', true),
('core.organization.custom_fields.read', 'core.organization', 'custom_fields', 'read', 'Read organization custom-field definitions.', 'ACTIVE', true),
('core.organization.custom_fields.manage', 'core.organization', 'custom_fields', 'manage', 'Manage organization custom-field definitions.', 'ACTIVE', true),
('core.organization.workflows.read', 'core.organization', 'workflows', 'read', 'Read organization workflow metadata.', 'ACTIVE', true),
('core.organization.workflows.manage', 'core.organization', 'workflows', 'manage', 'Manage organization workflow metadata.', 'ACTIVE', true),
('core.organization.notifications.read', 'core.organization', 'notifications', 'read', 'Read organization notification preferences.', 'ACTIVE', true),
('core.organization.notifications.manage', 'core.organization', 'notifications', 'manage', 'Manage organization notification preferences.', 'ACTIVE', true),
('core.organization.integrations.read', 'core.organization', 'integrations', 'read', 'Read organization integration metadata.', 'ACTIVE', true),
('core.organization.integrations.manage', 'core.organization', 'integrations', 'manage', 'Manage organization integration metadata.', 'ACTIVE', true),
('core.organization.domains.read', 'core.organization', 'domains', 'read', 'Read organization custom-domain metadata.', 'ACTIVE', true),
('core.organization.domains.manage', 'core.organization', 'domains', 'manage', 'Manage organization custom-domain metadata.', 'ACTIVE', true)
ON CONFLICT ("module_key", "resource_key", "action_key") DO NOTHING;--> statement-breakpoint
CREATE POLICY "feature_flag_assignments_platform_migration_write" ON "feature_flag_assignments" FOR ALL TO onecore_migrator USING ("organization_id" IS NULL) WITH CHECK ("organization_id" IS NULL);--> statement-breakpoint
CREATE POLICY "roles_migration_read" ON "roles" FOR SELECT TO onecore_migrator USING (true);--> statement-breakpoint
DO $$
DECLARE
        tenant_id uuid;
        permission_row record;
        new_permission_id uuid;
        admin_role_id uuid;
BEGIN
        FOR tenant_id IN
                SELECT DISTINCT "organization_id"
                FROM "roles"
                WHERE "name" = 'Organization Admin' AND "is_system" = true
        LOOP
                PERFORM set_config('app.current_organization_id', tenant_id::text, true);
                SELECT "id" INTO admin_role_id
                FROM "roles"
                WHERE "organization_id" = tenant_id
                        AND "name" = 'Organization Admin'
                        AND "is_system" = true;
                FOR permission_row IN
                        SELECT "id", "key"
                        FROM "permissions"
                        WHERE "key" LIKE 'core.organization.%'
                                AND "resource_key" IN ('features', 'custom_fields', 'workflows', 'notifications', 'integrations', 'domains')
                LOOP
                        INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope_type", "scope")
                        VALUES (tenant_id, admin_role_id, permission_row."id", 'ORGANIZATION', '{}'::jsonb)
                        ON CONFLICT DO NOTHING
                        RETURNING "permission_id" INTO new_permission_id;
                        IF FOUND THEN
                                INSERT INTO "audit_logs" ("organization_id", "action", "resource", "resource_id", "result", "request_metadata")
                                VALUES (
                                        tenant_id,
                                        'ROLE_PERMISSION_GRANTED',
                                        'role_permission',
                                        admin_role_id::text || ':' || new_permission_id::text,
                                        'SUCCESS',
                                        jsonb_build_object('source', 'phase_7_default_role_permissions', 'permissionKey', permission_row."key")
                                );
                        END IF;
                END LOOP;
        END LOOP;
        PERFORM set_config('app.current_organization_id', '', true);
END $$;--> statement-breakpoint