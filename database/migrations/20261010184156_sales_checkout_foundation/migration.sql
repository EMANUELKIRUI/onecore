CREATE TYPE "sale_status" AS ENUM('OPEN');--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_name" varchar(200) NOT NULL,
	"description" text,
	"reference" varchar(100),
	"unit" varchar(50) NOT NULL,
	"unit_price" numeric(18,6) NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" numeric(26,6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_lines_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "sale_lines_org_sale_line_number_unique" UNIQUE("organization_id","sale_id","line_number"),
	CONSTRAINT "sale_lines_org_sale_catalog_item_unique" UNIQUE("organization_id","sale_id","catalog_item_id"),
	CONSTRAINT "sale_lines_line_number_range" CHECK ("line_number" BETWEEN 1 AND 100),
	CONSTRAINT "sale_lines_price_nonnegative" CHECK ("unit_price" >= 0),
	CONSTRAINT "sale_lines_quantity_positive" CHECK ("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "sale_lines_total_nonnegative" CHECK ("line_total" >= 0),
	CONSTRAINT "sale_lines_total_matches_quantity" CHECK ("line_total" = "unit_price" * "quantity")
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" "sale_status" DEFAULT 'OPEN'::"sale_status" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"subtotal" numeric(26,6) NOT NULL,
	"total" numeric(26,6) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "sales_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "sales_subtotal_nonnegative" CHECK ("subtotal" >= 0),
	CONSTRAINT "sales_total_matches_subtotal" CHECK ("total" = "subtotal"),
	CONSTRAINT "sales_idempotency_key_format" CHECK ("idempotency_key" ~ '^[!-~]{1,200}$'),
	CONSTRAINT "sales_request_hash_format" CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_org_idempotency_unique" ON "sales" ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sales_org_branch_created_idx" ON "sales" ("organization_id","branch_id","created_at","id");--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "sales"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_catalog_item_fk" FOREIGN KEY ("organization_id","catalog_item_id") REFERENCES "catalog_items"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
INSERT INTO "modules" ("key", "name", "description", "lifecycle", "is_available")
VALUES ('core.sales', 'Sales', 'Unpaid sales transaction records.', 'AVAILABLE', true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system")
VALUES
	('core.sales.sale.create', 'core.sales', 'sale', 'create', 'Create unpaid sales from active catalog items.', 'ACTIVE', true),
	('core.sales.sale.read', 'core.sales', 'sale', 'read', 'Read sales within the authorized organization and branch.', 'ACTIVE', true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_versions" ("module_id", "version", "status", "manifest")
SELECT "id", '1.0.0', 'AVAILABLE', jsonb_build_object(
	'name', 'core.sales',
	'version', '1.0.0',
	'displayName', 'Sales',
	'dependencies', '[]'::jsonb,
	'permissions', jsonb_build_array('core.sales.sale.create', 'core.sales.sale.read'),
	'features', '[]'::jsonb,
	'lifecycle', 'AVAILABLE'
)
FROM "modules"
WHERE "key" = 'core.sales'
ON CONFLICT ("module_id", "version") DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_permissions" ("module_id", "permission_id")
SELECT "modules"."id", "permissions"."id"
FROM "modules"
CROSS JOIN "permissions"
WHERE "modules"."key" = 'core.sales'
	AND "permissions"."module_key" = 'core.sales'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sales_tenant_isolation" ON "sales"
	USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
	WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "sale_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sale_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sale_lines_tenant_isolation" ON "sale_lines"
	USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
	WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION reject_sale_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'Sale records and snapshots are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sales_immutable
	BEFORE UPDATE OR DELETE ON "sales"
	FOR EACH ROW EXECUTE FUNCTION reject_sale_mutation();
--> statement-breakpoint
CREATE TRIGGER sale_lines_immutable
	BEFORE UPDATE OR DELETE ON "sale_lines"
	FOR EACH ROW EXECUTE FUNCTION reject_sale_mutation();
--> statement-breakpoint
GRANT SELECT ON "sales", "sale_lines" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("id", "organization_id", "branch_id", "status", "currency", "subtotal", "total", "idempotency_key", "request_hash", "created_by_user_id", "created_at")
	ON "sales" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("id", "organization_id", "sale_id", "catalog_item_id", "line_number", "item_name", "description", "reference", "unit", "unit_price", "quantity", "line_total", "created_at")
	ON "sale_lines" TO onecore_app;