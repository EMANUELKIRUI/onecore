DROP INDEX "custom_domains_single_primary_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_single_primary_idx" ON "custom_domains" ("organization_id") WHERE "is_primary" = true;--> statement-breakpoint
DROP INDEX "workflow_versions_single_published_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_single_published_idx" ON "workflow_versions" ("organization_id","workflow_id") WHERE "status" = 'PUBLISHED';--> statement-breakpoint
ALTER TABLE "custom_domains" DROP CONSTRAINT "custom_domains_type_check", ADD CONSTRAINT "custom_domains_type_check" CHECK ("domain_type" in ('DOMAIN', 'SUBDOMAIN'));--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" DROP CONSTRAINT "feature_flag_assignments_scope_check", ADD CONSTRAINT "feature_flag_assignments_scope_check" CHECK (("scope" = 'GLOBAL' and "environment" is null and "module_id" is null and "organization_id" is null and "user_id" is null)
        or ("scope" = 'ENVIRONMENT' and "environment" is not null and "module_id" is null and "organization_id" is null and "user_id" is null)
        or ("scope" = 'MODULE' and "environment" is null and "module_id" is not null and "organization_id" is null and "user_id" is null)
        or ("scope" = 'ORGANIZATION' and "environment" is null and "module_id" is null and "organization_id" is not null and "user_id" is null)
        or ("scope" = 'USER' and "environment" is null and "module_id" is null and "organization_id" is not null and "user_id" is not null));