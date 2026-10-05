CREATE TYPE "platform_role" AS ENUM('SUPERADMIN', 'SUPPORT', 'SECURITY', 'OPERATIONS', 'ENGINEERING');--> statement-breakpoint
CREATE TYPE "user_account_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED');--> statement-breakpoint
CREATE TABLE "platform_user_roles" (
	"user_id" uuid,
	"role" "platform_role",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_user_id" uuid,
	CONSTRAINT "platform_user_roles_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"secret_hash" varchar(64) NOT NULL UNIQUE,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" varchar(45),
	"user_agent" varchar(512),
	CONSTRAINT "sessions_expiry_after_creation" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DATA TYPE "user_account_status" USING "status"::"user_account_status";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"user_account_status";--> statement-breakpoint
CREATE INDEX "audit_logs_auth_time_idx" ON "audit_logs" ("occurred_at") WHERE "resource" = 'authentication';--> statement-breakpoint
CREATE INDEX "sessions_user_expiry_idx" ON "sessions" ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_granted_by_user_id_users_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_attempts_nonnegative" CHECK ("failed_login_attempts" >= 0);--> statement-breakpoint
CREATE POLICY "organization_memberships_authenticated_user_read" ON "organization_memberships" FOR SELECT USING ("user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organizations_authenticated_membership_read" ON "organizations" FOR SELECT USING (EXISTS (SELECT 1 FROM "organization_memberships" AS "identity_membership" WHERE "identity_membership"."organization_id" = "organizations"."id" AND "identity_membership"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid AND "identity_membership"."status" = 'ACTIVE'));--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "users_identity_scope" ON "users" USING ("id" = nullif(current_setting('app.current_user_id', true), '')::uuid OR lower("email") = nullif(current_setting('app.current_login_email', true), '')) WITH CHECK ("id" = nullif(current_setting('app.current_user_id', true), '')::uuid OR lower("email") = nullif(current_setting('app.current_login_email', true), ''));--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sessions_identity_scope" ON "sessions" USING ("user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid OR "secret_hash" = nullif(current_setting('app.current_session_hash', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid OR "secret_hash" = nullif(current_setting('app.current_session_hash', true), ''));--> statement-breakpoint
ALTER TABLE "platform_user_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_user_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "platform_user_roles_self_read" ON "platform_user_roles" FOR SELECT USING ("user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY "audit_logs_tenant_isolation" ON "audit_logs";--> statement-breakpoint
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid OR ("organization_id" IS NULL AND "resource" = 'authentication'));