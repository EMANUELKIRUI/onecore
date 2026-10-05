CREATE TYPE "public"."audit_result" AS ENUM('SUCCESS', 'FAILURE');--> statement-breakpoint
CREATE TYPE "public"."billing_interval" AS ENUM('MONTHLY', 'ANNUAL', 'CUSTOM', 'ENTERPRISE');--> statement-breakpoint
CREATE TYPE "public"."custom_development_status" AS ENUM('REQUESTED', 'REVIEWED', 'SCOPED', 'QUOTED', 'CLIENT_APPROVED', 'DESIGNED', 'DEVELOPED', 'TESTED', 'STAGED', 'CLIENT_UAT', 'APPROVED', 'DEPLOYED', 'ENABLED');--> statement-breakpoint
CREATE TYPE "public"."custom_domain_verification_status" AS ENUM('PENDING', 'VERIFIED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."custom_field_type" AS ENUM('TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'DATETIME', 'CURRENCY', 'SELECT', 'MULTI_SELECT', 'REFERENCE');--> statement-breakpoint
CREATE TYPE "public"."data_scope_type" AS ENUM('ORGANIZATION', 'BRANCH', 'DEPARTMENT', 'SELF', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."deployment_type" AS ENUM('SAAS', 'CUSTOM', 'DEDICATED', 'ENTERPRISE');--> statement-breakpoint
CREATE TYPE "public"."entitlement_source" AS ENUM('SUBSCRIPTION', 'MANUAL', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_scope" AS ENUM('GLOBAL', 'ENVIRONMENT', 'MODULE', 'ORGANIZATION', 'USER');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."organization_module_status" AS ENUM('AVAILABLE', 'ENABLED', 'DISABLED', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('PENDING', 'UNDER_REVIEW', 'APPROVED', 'PAYMENT_PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ssl_status" AS ENUM('PENDING', 'ACTIVE', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('PENDING', 'ACTIVE', 'GRACE_PERIOD', 'SUSPENDED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."workflow_version_status" AS ENUM('DRAFT', 'PUBLISHED', 'RETIRED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(150) NOT NULL,
	"resource" varchar(150) NOT NULL,
	"resource_id" varchar(200) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"result" "audit_result" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"code" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "branches_organization_code_unique" UNIQUE("organization_id","code")
);
--> statement-breakpoint
CREATE TABLE "business_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"legal_name" varchar(200),
	"registration_number" varchar(100),
	"tax_number" varchar(100),
	"payment_methods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_development_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"quote_id" uuid,
	"approver_user_id" uuid NOT NULL,
	"decision" varchar(30) NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "custom_development_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"from_status" "custom_development_status",
	"to_status" "custom_development_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_development_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"project_key" varchar(100) NOT NULL,
	"status" varchar(30) DEFAULT 'PLANNED' NOT NULL,
	"assigned_team" varchar(150),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "custom_development_projects_org_key_unique" UNIQUE("organization_id","project_key")
);
--> statement-breakpoint
CREATE TABLE "custom_development_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"valid_until" date,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_development_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" varchar(50) NOT NULL,
	"status" varchar(30) DEFAULT 'PLANNED' NOT NULL,
	"released_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "custom_development_releases_project_version_unique" UNIQUE("organization_id","project_id","version")
);
--> statement-breakpoint
CREATE TABLE "custom_development_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"priority" varchar(20) DEFAULT 'NORMAL' NOT NULL,
	"status" "custom_development_status" DEFAULT 'REQUESTED' NOT NULL,
	"estimated_cost" numeric(20, 6),
	"approved_cost" numeric(20, 6),
	"currency_code" varchar(3),
	"assigned_team" varchar(150),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_development_requests_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "custom_development_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"details" text NOT NULL,
	"priority" varchar(20) DEFAULT 'NORMAL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" varchar(253) NOT NULL,
	"domain_type" varchar(20) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verification_status" "custom_domain_verification_status" DEFAULT 'PENDING' NOT NULL,
	"ssl_status" "ssl_status" DEFAULT 'PENDING' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_domains_domain_unique" UNIQUE("domain"),
	CONSTRAINT "custom_domains_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" varchar(100) NOT NULL,
	"key" varchar(100) NOT NULL,
	"label" varchar(150) NOT NULL,
	"field_type" "custom_field_type" NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_definitions_org_entity_key_unique" UNIQUE("organization_id","entity_type","key"),
	CONSTRAINT "custom_field_definitions_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"resource_type" varchar(100) NOT NULL,
	"resource_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_values_org_entity_field_unique" UNIQUE("organization_id","resource_type","resource_id","definition_id")
);
--> statement-breakpoint
CREATE TABLE "extension_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_configurations_org_extension_unique" UNIQUE("organization_id","extension_id")
);
--> statement-breakpoint
CREATE TABLE "extension_dependencies" (
	"extension_id" uuid NOT NULL,
	"dependency_extension_id" uuid NOT NULL,
	"minimum_version" varchar(50),
	CONSTRAINT "extension_dependencies_pk" PRIMARY KEY("extension_id","dependency_extension_id")
);
--> statement-breakpoint
CREATE TABLE "extension_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extension_version_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"deployed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_permissions" (
	"extension_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "extension_permissions_pk" PRIMARY KEY("extension_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "extension_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extension_id" uuid NOT NULL,
	"version" varchar(50) NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'AVAILABLE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_versions_extension_version_unique" UNIQUE("extension_id","version")
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(150) NOT NULL,
	"publisher" varchar(150) NOT NULL,
	"is_available" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extensions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "feature_flag_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_id" uuid NOT NULL,
	"scope" "feature_flag_scope" NOT NULL,
	"environment" varchar(30),
	"module_id" uuid,
	"organization_id" uuid,
	"user_id" uuid,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"description" text NOT NULL,
	"default_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "features_module_key_unique" UNIQUE("module_id","key")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_reference" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_org_key_unique" UNIQUE("organization_id","key"),
	CONSTRAINT "integrations_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "membership_branches" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_branches_pk" PRIMARY KEY("organization_id","membership_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "membership_data_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"scope_type" "data_scope_type" NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_roles" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_roles_pk" PRIMARY KEY("organization_id","membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "module_dependencies" (
	"module_id" uuid NOT NULL,
	"dependency_module_id" uuid NOT NULL,
	"minimum_version" varchar(50),
	CONSTRAINT "module_dependencies_pk" PRIMARY KEY("module_id","dependency_module_id")
);
--> statement-breakpoint
CREATE TABLE "module_permissions" (
	"module_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "module_permissions_pk" PRIMARY KEY("module_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "module_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"version" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'AVAILABLE' NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_versions_module_version_unique" UNIQUE("module_id","version")
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"is_available" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modules_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "notification_configurations" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "numbering_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_type" varchar(80) NOT NULL,
	"prefix" varchar(30) DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"padding" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "numbering_configurations_org_type_unique" UNIQUE("organization_id","document_type")
);
--> statement-breakpoint
CREATE TABLE "organization_branding" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"logo_url" text,
	"favicon_url" text,
	"primary_color" varchar(7),
	"secondary_color" varchar(7),
	"invoice_template" varchar(100),
	"receipt_template" varchar(100),
	"email_branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sms_sender" varchar(20),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_configurations_org_key_unique" UNIQUE("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "organization_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entitlement_key" varchar(120) NOT NULL,
	"source" "entitlement_source" NOT NULL,
	"value" jsonb NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_entitlements_org_key_unique" UNIQUE("organization_id","entitlement_key")
);
--> statement-breakpoint
CREATE TABLE "organization_features" (
	"organization_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"source" "entitlement_source" DEFAULT 'MANUAL' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_features_pk" PRIMARY KEY("organization_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'INVITED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_org_user_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "organization_memberships_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "organization_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"status" "organization_module_status" DEFAULT 'AVAILABLE' NOT NULL,
	"source" "entitlement_source" DEFAULT 'MANUAL' NOT NULL,
	"enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_modules_org_module_unique" UNIQUE("organization_id","module_id"),
	CONSTRAINT "organization_modules_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"timezone" varchar(100) NOT NULL,
	"locale" varchar(20) DEFAULT 'en' NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tax_information" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"industry" varchar(100) NOT NULL,
	"status" "organization_status" DEFAULT 'PENDING' NOT NULL,
	"deployment_type" "deployment_type" DEFAULT 'SAAS' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(150) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"organization_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(150) NOT NULL,
	"module_key" varchar(100),
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "plan_features" (
	"plan_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	CONSTRAINT "plan_features_pk" PRIMARY KEY("plan_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "plan_modules" (
	"plan_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	CONSTRAINT "plan_modules_pk" PRIMARY KEY("plan_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(150) NOT NULL,
	"billing_interval" "billing_interval" NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pk" PRIMARY KEY("organization_id","role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_organization_name_unique" UNIQUE("organization_id","name"),
	CONSTRAINT "roles_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "subscription_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"change_type" varchar(50) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"plan_id" uuid,
	"module_id" uuid,
	"feature_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'PENDING' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"grace_period_ends_at" timestamp with time zone,
	"custom_quote_reference" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "tax_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(80) NOT NULL,
	"name" varchar(100) NOT NULL,
	"rate" numeric(12, 8) NOT NULL,
	"is_inclusive" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_configurations_org_key_unique" UNIQUE("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workflow_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"action_type" varchar(80) NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"expression" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(150) NOT NULL,
	"status" "workflow_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_definitions_org_key_unique" UNIQUE("organization_id","key"),
	CONSTRAINT "workflow_definitions_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"status" varchar(30) DEFAULT 'PENDING' NOT NULL,
	"resource_type" varchar(100) NOT NULL,
	"resource_id" uuid NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(150) NOT NULL,
	"position" integer NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "workflow_steps_version_key_unique" UNIQUE("organization_id","workflow_version_id","key")
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"from_step_id" uuid NOT NULL,
	"to_step_id" uuid NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"trigger_type" varchar(80) NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "workflow_version_status" DEFAULT 'DRAFT' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_versions_org_workflow_version_unique" UNIQUE("organization_id","workflow_id","version"),
	CONSTRAINT "workflow_versions_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_approvals" ADD CONSTRAINT "custom_development_approvals_quote_id_custom_development_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."custom_development_quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_approvals" ADD CONSTRAINT "custom_development_approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_approvals" ADD CONSTRAINT "custom_development_approvals_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."custom_development_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_history" ADD CONSTRAINT "custom_development_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_history" ADD CONSTRAINT "custom_development_history_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."custom_development_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_projects" ADD CONSTRAINT "custom_development_projects_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."custom_development_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_quotes" ADD CONSTRAINT "custom_development_quotes_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."custom_development_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_requests" ADD CONSTRAINT "custom_development_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_requests" ADD CONSTRAINT "custom_development_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_requirements" ADD CONSTRAINT "custom_development_requirements_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."custom_development_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definition_fk" FOREIGN KEY ("organization_id","definition_id") REFERENCES "public"."custom_field_definitions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_configurations" ADD CONSTRAINT "extension_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_configurations" ADD CONSTRAINT "extension_configurations_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_dependencies" ADD CONSTRAINT "extension_dependencies_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_dependencies" ADD CONSTRAINT "extension_dependencies_dependency_extension_id_extensions_id_fk" FOREIGN KEY ("dependency_extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_deployments" ADD CONSTRAINT "extension_deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_deployments" ADD CONSTRAINT "extension_deployments_extension_version_id_extension_versions_id_fk" FOREIGN KEY ("extension_version_id") REFERENCES "public"."extension_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_permissions" ADD CONSTRAINT "extension_permissions_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_permissions" ADD CONSTRAINT "extension_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_versions" ADD CONSTRAINT "extension_versions_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD CONSTRAINT "feature_flag_assignments_flag_id_feature_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."feature_flags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD CONSTRAINT "feature_flag_assignments_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD CONSTRAINT "feature_flag_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ADD CONSTRAINT "feature_flag_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_membership_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "public"."branches"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_data_scopes" ADD CONSTRAINT "membership_data_scopes_membership_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_dependencies" ADD CONSTRAINT "module_dependencies_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_dependencies" ADD CONSTRAINT "module_dependencies_dependency_module_id_modules_id_fk" FOREIGN KEY ("dependency_module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_permissions" ADD CONSTRAINT "module_permissions_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_permissions" ADD CONSTRAINT "module_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_versions" ADD CONSTRAINT "module_versions_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_configurations" ADD CONSTRAINT "notification_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numbering_configurations" ADD CONSTRAINT "numbering_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_configurations" ADD CONSTRAINT "organization_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_features" ADD CONSTRAINT "organization_features_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_features" ADD CONSTRAINT "organization_features_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_modules" ADD CONSTRAINT "organization_modules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_modules" ADD CONSTRAINT "organization_modules_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_modules" ADD CONSTRAINT "plan_modules_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_modules" ADD CONSTRAINT "plan_modules_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_history" ADD CONSTRAINT "subscription_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_history" ADD CONSTRAINT "subscription_history_subscription_fk" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "public"."subscriptions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_fk" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "public"."subscriptions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_configurations" ADD CONSTRAINT "tax_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_version_fk" FOREIGN KEY ("organization_id","workflow_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_version_fk" FOREIGN KEY ("organization_id","workflow_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_version_fk" FOREIGN KEY ("organization_id","workflow_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_version_fk" FOREIGN KEY ("organization_id","workflow_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_fk" FOREIGN KEY ("organization_id","workflow_id") REFERENCES "public"."workflow_definitions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_time_idx" ON "audit_logs" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_resource_idx" ON "audit_logs" USING btree ("organization_id","resource","resource_id");--> statement-breakpoint
CREATE INDEX "branches_organization_idx" ON "branches" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "custom_development_history_org_time_idx" ON "custom_development_history" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "custom_development_requests_org_status_idx" ON "custom_development_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "custom_domains_org_primary_idx" ON "custom_domains" USING btree ("organization_id","is_primary");--> statement-breakpoint
CREATE INDEX "custom_field_definitions_org_entity_idx" ON "custom_field_definitions" USING btree ("organization_id","entity_type");--> statement-breakpoint
CREATE INDEX "custom_field_values_resource_idx" ON "custom_field_values" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "extension_deployments_org_status_idx" ON "extension_deployments" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "feature_flag_assignments_lookup_idx" ON "feature_flag_assignments" USING btree ("flag_id","scope","organization_id","user_id");--> statement-breakpoint
CREATE INDEX "membership_data_scopes_member_idx" ON "membership_data_scopes" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_user_idx" ON "organization_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organization_modules_org_status_idx" ON "organization_modules" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "organizations_status_idx" ON "organizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("status","occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_events_org_idx" ON "outbox_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "plans_available_idx" ON "plans" USING btree ("is_available");--> statement-breakpoint
CREATE INDEX "subscription_history_org_time_idx" ON "subscription_history" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_items_subscription_idx" ON "subscription_items" USING btree ("organization_id","subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_org_status_idx" ON "subscriptions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_executions_org_status_idx" ON "workflow_executions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "workflow_versions_activation_idx" ON "workflow_versions" USING btree ("organization_id","workflow_id","status");
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organizations_tenant_isolation" ON "organizations" USING ("id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "branches_tenant_isolation" ON "branches" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_memberships_tenant_isolation" ON "organization_memberships" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "roles_tenant_isolation" ON "roles" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_isolation" ON "role_permissions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "membership_roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "membership_roles_tenant_isolation" ON "membership_roles" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "membership_branches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership_branches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "membership_branches_tenant_isolation" ON "membership_branches" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "membership_data_scopes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership_data_scopes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "membership_data_scopes_tenant_isolation" ON "membership_data_scopes" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_modules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_modules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_modules_tenant_isolation" ON "organization_modules" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_features" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_features" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_features_tenant_isolation" ON "organization_features" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscriptions_tenant_isolation" ON "subscriptions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subscription_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_items_tenant_isolation" ON "subscription_items" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subscription_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_history_tenant_isolation" ON "subscription_history" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_entitlements_tenant_isolation" ON "organization_entitlements" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_configurations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_configurations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_configurations_tenant_isolation" ON "organization_configurations" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_settings_tenant_isolation" ON "organization_settings" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "business_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "business_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "business_settings_tenant_isolation" ON "business_settings" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_branding" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_branding" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_branding_tenant_isolation" ON "organization_branding" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "numbering_configurations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "numbering_configurations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "numbering_configurations_tenant_isolation" ON "numbering_configurations" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tax_configurations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tax_configurations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tax_configurations_tenant_isolation" ON "tax_configurations" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "notification_configurations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_configurations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_configurations_tenant_isolation" ON "notification_configurations" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_isolation" ON "custom_field_definitions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_field_values" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_field_values" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_field_values_tenant_isolation" ON "custom_field_values" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_definitions_tenant_isolation" ON "workflow_definitions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_versions_tenant_isolation" ON "workflow_versions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_steps_tenant_isolation" ON "workflow_steps" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_transitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_transitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_transitions_tenant_isolation" ON "workflow_transitions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_triggers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_triggers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_triggers_tenant_isolation" ON "workflow_triggers" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_actions_tenant_isolation" ON "workflow_actions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_conditions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_conditions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_conditions_tenant_isolation" ON "workflow_conditions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflow_executions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_executions_tenant_isolation" ON "workflow_executions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "integrations_tenant_isolation" ON "integrations" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_domains" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_domains_tenant_isolation" ON "custom_domains" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "extension_configurations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "extension_configurations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "extension_configurations_tenant_isolation" ON "extension_configurations" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "extension_deployments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "extension_deployments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "extension_deployments_tenant_isolation" ON "extension_deployments" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_development_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_development_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_development_requests_tenant_isolation" ON "custom_development_requests" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_development_requirements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_development_requirements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_development_requirements_tenant_isolation" ON "custom_development_requirements" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_development_quotes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_development_quotes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_development_quotes_tenant_isolation" ON "custom_development_quotes" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_development_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_development_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_development_approvals_tenant_isolation" ON "custom_development_approvals" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_development_projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_development_projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_development_projects_tenant_isolation" ON "custom_development_projects" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_development_releases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_development_releases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_development_releases_tenant_isolation" ON "custom_development_releases" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_development_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_development_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "custom_development_history_tenant_isolation" ON "custom_development_history" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "feature_flag_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "feature_flag_assignments_tenant_isolation" ON "feature_flag_assignments" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "feature_flag_assignments_platform_read" ON "feature_flag_assignments" FOR SELECT USING ("organization_id" IS NULL OR "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION "prevent_audit_log_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit logs are append-only'; END; $$;
--> statement-breakpoint
CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION "prevent_audit_log_mutation"();