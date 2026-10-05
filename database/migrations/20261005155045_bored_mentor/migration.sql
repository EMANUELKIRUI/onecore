CREATE TABLE "organization_storage" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"provider" varchar(80) NOT NULL,
	"storage_reference" varchar(500) NOT NULL,
	"region" varchar(100),
	"quota_bytes" numeric(20, 0),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_storage" ADD CONSTRAINT "organization_storage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_type_check" CHECK ("custom_domains"."domain_type" in ('DOMAIN', 'SUBDOMAIN'));
--> statement-breakpoint
ALTER TABLE "organization_storage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_storage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_storage_tenant_isolation" ON "organization_storage" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);