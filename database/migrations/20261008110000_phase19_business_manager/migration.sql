INSERT INTO "modules" ("key", "name", "description", "lifecycle", "is_available")
VALUES (
  'core.business_manager',
  'Business Manager',
  'Customer and product/service master data.',
  'AVAILABLE',
  true
)
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "lifecycle" = 'AVAILABLE',
  "is_available" = true,
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system")
VALUES
  ('core.business_manager.customer.create', 'core.business_manager', 'customer', 'create', 'Create Business Manager customer records.', 'ACTIVE', true),
  ('core.business_manager.customer.read', 'core.business_manager', 'customer', 'read', 'Read Business Manager customer records.', 'ACTIVE', true),
  ('core.business_manager.customer.update', 'core.business_manager', 'customer', 'update', 'Update Business Manager customer records.', 'ACTIVE', true),
  ('core.business_manager.customer.delete', 'core.business_manager', 'customer', 'delete', 'Deactivate Business Manager customer records.', 'ACTIVE', true),
  ('core.business_manager.catalog.create', 'core.business_manager', 'catalog', 'create', 'Create Business Manager catalog records.', 'ACTIVE', true),
  ('core.business_manager.catalog.read', 'core.business_manager', 'catalog', 'read', 'Read Business Manager catalog records.', 'ACTIVE', true),
  ('core.business_manager.catalog.update', 'core.business_manager', 'catalog', 'update', 'Update Business Manager catalog records.', 'ACTIVE', true),
  ('core.business_manager.catalog.delete', 'core.business_manager', 'catalog', 'delete', 'Deactivate Business Manager catalog records.', 'ACTIVE', true)
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "status" = 'ACTIVE';
--> statement-breakpoint
INSERT INTO "module_versions" ("module_id", "version", "status", "manifest")
SELECT
  "modules"."id",
  '1.0.0',
  'AVAILABLE',
  jsonb_build_object(
    'name', 'core.business_manager',
    'version', '1.0.0',
    'displayName', 'Business Manager',
    'dependencies', '[]'::jsonb,
    'permissions', jsonb_build_array(
      'core.business_manager.customer.create',
      'core.business_manager.customer.read',
      'core.business_manager.customer.update',
      'core.business_manager.customer.delete',
      'core.business_manager.catalog.create',
      'core.business_manager.catalog.read',
      'core.business_manager.catalog.update',
      'core.business_manager.catalog.delete'
    ),
    'features', '[]'::jsonb,
    'lifecycle', 'AVAILABLE'
  )
FROM "modules"
WHERE "modules"."key" = 'core.business_manager'
ON CONFLICT ("module_id", "version") DO UPDATE SET
  "status" = EXCLUDED."status",
  "manifest" = EXCLUDED."manifest";
--> statement-breakpoint
INSERT INTO "module_permissions" ("module_id", "permission_id")
SELECT "modules"."id", "permissions"."id"
FROM "modules"
CROSS JOIN "permissions"
WHERE "modules"."key" = 'core.business_manager'
  AND "permissions"."module_key" = 'core.business_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plan_modules" ("plan_id", "module_id")
SELECT "plan_modules"."plan_id", "business_manager"."id"
FROM "plan_modules"
JOIN "modules" AS "organization_module"
  ON "organization_module"."id" = "plan_modules"."module_id"
 AND "organization_module"."key" = 'core.organization'
CROSS JOIN "modules" AS "business_manager"
WHERE "business_manager"."key" = 'core.business_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "organization_modules"
  ("organization_id", "module_id", "status", "source", "enabled_at")
SELECT "organization_modules"."organization_id", "business_manager"."id",
  'ENABLED', "organization_modules"."source", now()
FROM "organization_modules"
JOIN "modules" AS "organization_module"
  ON "organization_module"."id" = "organization_modules"."module_id"
 AND "organization_module"."key" = 'core.organization'
CROSS JOIN "modules" AS "business_manager"
WHERE "organization_modules"."status" = 'ENABLED'
  AND "business_manager"."key" = 'core.business_manager'
ON CONFLICT ("organization_id", "module_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id")
SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
FROM "roles"
CROSS JOIN "permissions"
WHERE "roles"."status" = 'ACTIVE'
  AND "roles"."name" IN ('Organization Owner', 'Organization Admin')
  AND "permissions"."module_key" = 'core.business_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id")
SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
FROM "roles"
JOIN "permissions"
  ON "permissions"."key" IN (
    'core.business_manager.customer.read',
    'core.business_manager.customer.create',
    'core.business_manager.customer.update',
    'core.business_manager.catalog.read',
    'core.business_manager.catalog.create',
    'core.business_manager.catalog.update'
  )
WHERE "roles"."status" = 'ACTIVE'
  AND "roles"."name" = 'Manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id")
SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
FROM "roles"
JOIN "permissions"
  ON "permissions"."key" IN (
    'core.business_manager.customer.read',
    'core.business_manager.catalog.read'
  )
WHERE "roles"."status" = 'ACTIVE'
  AND "roles"."name" IN ('Staff', 'Viewer')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "branch_id" uuid,
  "reference" varchar(100),
  "name" varchar(200) NOT NULL,
  "customer_type" varchar(20) NOT NULL,
  "phone" varchar(50),
  "email" varchar(320),
  "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
  "notes" text,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customers_organization_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "customers_organization_fk" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "customers_branch_fk" FOREIGN KEY ("organization_id", "branch_id")
    REFERENCES "branches" ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "customers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "customers_type_check" CHECK ("customer_type" IN ('INDIVIDUAL', 'BUSINESS')),
  CONSTRAINT "customers_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT "customers_name_nonempty" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "customers_reference_normalized" CHECK ("reference" IS NULL OR "reference" = upper("reference")),
  CONSTRAINT "customers_email_valid" CHECK ("email" IS NULL OR "email" ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT "customers_notes_length" CHECK ("notes" IS NULL OR char_length("notes") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_reference_unique"
  ON "customers" ("organization_id", lower("reference"))
  WHERE "reference" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "customers_org_status_updated_idx"
  ON "customers" ("organization_id", "status", "updated_at");
--> statement-breakpoint
CREATE INDEX "customers_org_branch_status_idx"
  ON "customers" ("organization_id", "branch_id", "status");
--> statement-breakpoint
CREATE INDEX "customers_org_name_idx"
  ON "customers" ("organization_id", "name");
--> statement-breakpoint
CREATE TABLE "catalog_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "branch_id" uuid,
  "reference" varchar(100),
  "name" varchar(200) NOT NULL,
  "description" text,
  "type" varchar(20) NOT NULL,
  "unit" varchar(50) NOT NULL,
  "price" numeric(18, 6) NOT NULL,
  "currency" varchar(3) NOT NULL,
  "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "catalog_items_organization_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "catalog_items_organization_fk" FOREIGN KEY ("organization_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "catalog_items_branch_fk" FOREIGN KEY ("organization_id", "branch_id")
    REFERENCES "branches" ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "catalog_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "catalog_items_type_check" CHECK ("type" IN ('PRODUCT', 'SERVICE')),
  CONSTRAINT "catalog_items_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT "catalog_items_price_nonnegative" CHECK ("price" >= 0),
  CONSTRAINT "catalog_items_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "catalog_items_name_nonempty" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "catalog_items_unit_nonempty" CHECK (length(btrim("unit")) > 0),
  CONSTRAINT "catalog_items_reference_normalized" CHECK ("reference" IS NULL OR "reference" = upper("reference")),
  CONSTRAINT "catalog_items_description_length" CHECK ("description" IS NULL OR char_length("description") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_org_reference_unique"
  ON "catalog_items" ("organization_id", lower("reference"))
  WHERE "reference" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "catalog_items_org_status_updated_idx"
  ON "catalog_items" ("organization_id", "status", "updated_at");
--> statement-breakpoint
CREATE INDEX "catalog_items_org_branch_status_idx"
  ON "catalog_items" ("organization_id", "branch_id", "status");
--> statement-breakpoint
CREATE INDEX "catalog_items_org_name_idx"
  ON "catalog_items" ("organization_id", "name");
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "customers_tenant_isolation" ON "customers"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "catalog_items_tenant_isolation" ON "catalog_items"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "customers", "catalog_items" TO onecore_app;
