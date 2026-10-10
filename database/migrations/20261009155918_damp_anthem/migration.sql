INSERT INTO "modules" ("key", "name", "description", "lifecycle", "is_available")
VALUES ('sales', 'Sales & POS', 'Branch-scoped sales checkout, payments, receipts, cancellations, and refunds.', 'AVAILABLE', true)
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "lifecycle" = 'AVAILABLE',
  "is_available" = true,
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system")
VALUES
  ('sales.sale.create', 'sales', 'sale', 'create', 'Create and complete sales.', 'ACTIVE', true),
  ('sales.sale.read', 'sales', 'sale', 'read', 'Read sales and receipts.', 'ACTIVE', true),
  ('sales.sale.update', 'sales', 'sale', 'update', 'Update permitted sale records.', 'ACTIVE', true),
  ('sales.sale.delete', 'sales', 'sale', 'delete', 'Delete sale records.', 'ACTIVE', true),
  ('sales.sale.payment_record', 'sales', 'sale', 'payment_record', 'Record configured manual payments.', 'ACTIVE', true),
  ('sales.sale.cancel', 'sales', 'sale', 'cancel', 'Cancel a sale and record its manual reversal.', 'ACTIVE', true),
  ('sales.sale.refund', 'sales', 'sale', 'refund', 'Record manual sale refunds.', 'ACTIVE', true),
  ('sales.sale.discount', 'sales', 'sale', 'discount', 'Apply configured sale discounts.', 'ACTIVE', true)
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "status" = 'ACTIVE';
--> statement-breakpoint
INSERT INTO "module_versions" ("module_id", "version", "status", "manifest")
SELECT "modules"."id", '1.0.0', 'AVAILABLE', jsonb_build_object(
  'name', 'sales',
  'version', '1.0.0',
  'displayName', 'Sales & POS',
  'dependencies', jsonb_build_array(jsonb_build_object('moduleName', 'core.business_manager', 'minimumVersion', '1.0.0')),
  'permissions', jsonb_build_array(
    'sales.sale.create', 'sales.sale.read', 'sales.sale.update', 'sales.sale.delete',
    'sales.sale.payment_record', 'sales.sale.cancel', 'sales.sale.refund', 'sales.sale.discount'
  ),
  'features', '[]'::jsonb,
  'lifecycle', 'AVAILABLE'
)
FROM "modules" WHERE "modules"."key" = 'sales'
ON CONFLICT ("module_id", "version") DO UPDATE SET
  "status" = EXCLUDED."status",
  "manifest" = EXCLUDED."manifest";
--> statement-breakpoint
INSERT INTO "module_permissions" ("module_id", "permission_id")
SELECT "modules"."id", "permissions"."id"
FROM "modules" CROSS JOIN "permissions"
WHERE "modules"."key" = 'sales' AND "permissions"."module_key" = 'sales'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_dependencies" ("module_id", "dependency_module_id", "minimum_version")
SELECT "sales"."id", "business_manager"."id", '1.0.0'
FROM "modules" AS "sales" CROSS JOIN "modules" AS "business_manager"
WHERE "sales"."key" = 'sales' AND "business_manager"."key" = 'core.business_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plan_modules" ("plan_id", "module_id")
SELECT "plan_modules"."plan_id", "sales"."id"
FROM "plan_modules"
JOIN "modules" AS "business_manager"
  ON "business_manager"."id" = "plan_modules"."module_id"
 AND "business_manager"."key" = 'core.business_manager'
CROSS JOIN "modules" AS "sales"
WHERE "sales"."key" = 'sales'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE
  tenant_id uuid;
BEGIN
  FOR tenant_id IN
    SELECT "id" FROM "organizations" WHERE "status" = 'ACTIVE'
  LOOP
    PERFORM set_config('app.current_organization_id', tenant_id::text, true);
    INSERT INTO "organization_modules" (
      "organization_id", "module_id", "status", "source", "enabled_at"
    )
    SELECT "organization_modules"."organization_id", "sales"."id",
      'ENABLED', "organization_modules"."source", now()
    FROM "organization_modules"
    JOIN "modules" AS "business_manager"
      ON "business_manager"."id" = "organization_modules"."module_id"
     AND "business_manager"."key" = 'core.business_manager'
    CROSS JOIN "modules" AS "sales"
    WHERE "organization_modules"."organization_id" = tenant_id
      AND "organization_modules"."status" = 'ENABLED'
      AND "sales"."key" = 'sales'
    ON CONFLICT ("organization_id", "module_id") DO NOTHING;
  END LOOP;

  FOR tenant_id IN
    SELECT DISTINCT "organization_id"
    FROM "roles"
    WHERE "status" = 'ACTIVE'
      AND "name" IN (
        'Organization Owner', 'Organization Admin', 'Manager', 'Sales Cashier'
      )
  LOOP
    PERFORM set_config('app.current_organization_id', tenant_id::text, true);

    IF EXISTS (
      SELECT 1 FROM "organizations"
      WHERE "id" = tenant_id AND "status" = 'ACTIVE'
    ) THEN
      INSERT INTO "roles" (
        "organization_id", "name", "description", "is_system", "status"
      ) VALUES (
        tenant_id,
        'Sales Cashier',
        'Branch-scoped role for creating sales and recording configured manual payments.',
        true,
        'ACTIVE'
      ) ON CONFLICT ("organization_id", "name") DO NOTHING;
    END IF;

    INSERT INTO "role_permissions" (
      "organization_id", "role_id", "permission_id"
    )
    SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
    FROM "roles" CROSS JOIN "permissions"
    WHERE "roles"."organization_id" = tenant_id
      AND "roles"."status" = 'ACTIVE'
      AND "roles"."name" IN ('Organization Owner', 'Organization Admin')
      AND "permissions"."module_key" = 'sales'
    ON CONFLICT DO NOTHING;

    INSERT INTO "role_permissions" (
      "organization_id", "role_id", "permission_id"
    )
    SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
    FROM "roles"
    JOIN "permissions" ON "permissions"."key" IN (
      'sales.sale.create', 'sales.sale.read',
      'sales.sale.payment_record', 'sales.sale.discount'
    )
    WHERE "roles"."organization_id" = tenant_id
      AND "roles"."status" = 'ACTIVE'
      AND "roles"."name" = 'Manager'
    ON CONFLICT DO NOTHING;

    INSERT INTO "role_permissions" (
      "organization_id", "role_id", "permission_id"
    )
    SELECT "roles"."organization_id", "roles"."id", "permissions"."id"
    FROM "roles" CROSS JOIN "permissions"
    WHERE "roles"."organization_id" = tenant_id
      AND "roles"."name" = 'Sales Cashier'
      AND "permissions"."key" IN (
        'sales.sale.create', 'sales.sale.read', 'sales.sale.payment_record'
      )
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;
--> statement-breakpoint
CREATE TABLE "sales" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "branch_id" uuid NOT NULL,
  "sale_number" varchar(40) NOT NULL,
  "customer_id" uuid,
  "cashier_user_id" uuid NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "currency" varchar(3) NOT NULL,
  "subtotal" numeric(18, 6) NOT NULL,
  "discount" numeric(18, 6) DEFAULT '0' NOT NULL,
  "tax" numeric(18, 6) DEFAULT '0' NOT NULL,
  "total" numeric(18, 6) NOT NULL,
  "status" varchar(30) DEFAULT 'COMPLETED' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_organization_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "sales_organization_branch_id_unique" UNIQUE ("organization_id", "branch_id", "id"),
  CONSTRAINT "sales_org_number_unique" UNIQUE ("organization_id", "sale_number"),
  CONSTRAINT "sales_org_idempotency_unique" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "sales_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "sales_branch_fk" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches" ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "sales_customer_fk" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers" ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "sales_cashier_user_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "sales_status_check" CHECK ("status" IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED')),
  CONSTRAINT "sales_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "sales_subtotal_nonnegative" CHECK ("subtotal" >= 0),
  CONSTRAINT "sales_discount_nonnegative" CHECK ("discount" >= 0),
  CONSTRAINT "sales_discount_not_over_subtotal" CHECK ("discount" <= "subtotal"),
  CONSTRAINT "sales_tax_nonnegative" CHECK ("tax" >= 0),
  CONSTRAINT "sales_total_nonnegative" CHECK ("total" >= 0),
  CONSTRAINT "sales_totals_consistent" CHECK ("total" = "subtotal" - "discount" + "tax")
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "branch_id" uuid NOT NULL,
  "sale_id" uuid NOT NULL,
  "catalog_item_id" uuid NOT NULL,
  "item_reference" varchar(100),
  "item_name" varchar(200) NOT NULL,
  "item_type" varchar(20) NOT NULL,
  "unit" varchar(50) NOT NULL,
  "quantity" integer NOT NULL,
  "unit_price" numeric(18, 6) NOT NULL,
  "line_subtotal" numeric(18, 6) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sale_items_organization_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "sale_items_sale_fk" FOREIGN KEY ("organization_id", "branch_id", "sale_id") REFERENCES "sales" ("organization_id", "branch_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_items_catalog_fk" FOREIGN KEY ("organization_id", "catalog_item_id") REFERENCES "catalog_items" ("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_items_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "sale_items_price_nonnegative" CHECK ("unit_price" >= 0),
  CONSTRAINT "sale_items_subtotal_consistent" CHECK ("line_subtotal" = "unit_price" * "quantity"),
  CONSTRAINT "sale_items_type_check" CHECK ("item_type" IN ('PRODUCT', 'SERVICE'))
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "branch_id" uuid NOT NULL,
  "sale_id" uuid NOT NULL,
  "payment_method" varchar(20) NOT NULL,
  "amount" numeric(18, 6) NOT NULL,
  "payment_reference" varchar(100),
  "recorded_by_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sale_payments_organization_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "sale_payments_org_sale_unique" UNIQUE ("organization_id", "sale_id"),
  CONSTRAINT "sale_payments_sale_fk" FOREIGN KEY ("organization_id", "branch_id", "sale_id") REFERENCES "sales" ("organization_id", "branch_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_payments_user_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "sale_payments_method_check" CHECK ("payment_method" IN ('CASH', 'MANUAL')),
  CONSTRAINT "sale_payments_amount_nonnegative" CHECK ("amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sale_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "branch_id" uuid NOT NULL,
  "sale_id" uuid NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "amount" numeric(18, 6) NOT NULL,
  "reason" varchar(500) NOT NULL,
  "recorded_by_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sale_refunds_organization_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "sale_refunds_org_idempotency_unique" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "sale_refunds_sale_fk" FOREIGN KEY ("organization_id", "branch_id", "sale_id") REFERENCES "sales" ("organization_id", "branch_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_refunds_user_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "sale_refunds_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "sale_refunds_reason_nonempty" CHECK (length(btrim("reason")) >= 3)
);
--> statement-breakpoint
CREATE INDEX "sales_org_branch_created_idx" ON "sales" ("organization_id", "branch_id", "created_at");
--> statement-breakpoint
CREATE INDEX "sales_org_status_created_idx" ON "sales" ("organization_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "sale_items_org_sale_idx" ON "sale_items" ("organization_id", "sale_id");
--> statement-breakpoint
CREATE INDEX "sale_payments_org_branch_created_idx" ON "sale_payments" ("organization_id", "branch_id", "created_at");
--> statement-breakpoint
CREATE INDEX "sale_refunds_org_branch_created_idx" ON "sale_refunds" ("organization_id", "branch_id", "created_at");
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sales_branch_isolation" ON "sales"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "sale_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sale_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sale_items_branch_isolation" ON "sale_items"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "sale_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sale_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sale_payments_branch_isolation" ON "sale_payments"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "sale_refunds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sale_refunds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sale_refunds_branch_isolation" ON "sale_refunds"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON "sales" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("status", "updated_at") ON "sales" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "sale_items", "sale_payments", "sale_refunds" TO onecore_app;
