CREATE TYPE "job_status" AS ENUM('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "notification_channel" AS ENUM('IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK');--> statement-breakpoint
CREATE TYPE "notification_delivery_status" AS ENUM('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TYPE "stored_object_provider" AS ENUM('LOCAL');--> statement-breakpoint
CREATE TYPE "stored_object_status" AS ENUM('ACTIVE', 'DELETED');--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"worker_id" varchar(150) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" varchar(20) DEFAULT 'RUNNING' NOT NULL,
	"error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_attempts_job_attempt_unique" UNIQUE("organization_id","job_id","attempt"),
	CONSTRAINT "job_attempts_outcome_check" CHECK ("outcome" in ('RUNNING', 'SUCCEEDED', 'RETRY_WAIT', 'FAILED', 'ABANDONED')),
	CONSTRAINT "job_attempts_attempt_positive" CHECK ("attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"branch_id" uuid,
	"created_by_user_id" uuid,
	"job_type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" varchar(200),
	"status" "job_status" DEFAULT 'QUEUED'::"job_status" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" varchar(150),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "jobs_attempt_limits_check" CHECK ("attempts" >= 0 and "max_attempts" between 1 and 20 and "attempts" <= "max_attempts"),
	CONSTRAINT "jobs_priority_check" CHECK ("priority" between 0 and 100),
	CONSTRAINT "jobs_payload_size_check" CHECK (octet_length("payload"::text) <= 65536),
	CONSTRAINT "jobs_lease_state_check" CHECK (("status" = 'RUNNING' and "lease_owner" is not null and "lease_token" is not null and "lease_expires_at" is not null)
        or ("status" <> 'RUNNING' and "lease_owner" is null and "lease_token" is null and "lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_delivery_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel_unique" UNIQUE("organization_id","notification_id","channel"),
	CONSTRAINT "notification_deliveries_attempts_nonnegative" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"branch_id" uuid,
	"recipient_user_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"notification_type" varchar(100) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "notifications_body_size_check" CHECK (octet_length("body") <= 16384 and octet_length("metadata"::text) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"branch_id" uuid,
	"index_name" varchar(100) NOT NULL,
	"document_id" varchar(200) NOT NULL,
	"title" varchar(500) NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "search_documents_identity_unique" UNIQUE("organization_id","index_name","document_id"),
	CONSTRAINT "search_documents_size_check" CHECK (octet_length("body") <= 65536 and octet_length("metadata"::text) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "stored_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"branch_id" uuid,
	"created_by_user_id" uuid,
	"original_filename" varchar(255) NOT NULL,
	"storage_key" varchar(100) NOT NULL,
	"mime_type" varchar(127) NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"provider" "stored_object_provider" NOT NULL,
	"status" "stored_object_status" DEFAULT 'ACTIVE'::"stored_object_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_objects_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "stored_objects_key_unique" UNIQUE("organization_id","storage_key"),
	CONSTRAINT "stored_objects_size_check" CHECK ("byte_size" between 1 and 10485760),
	CONSTRAINT "stored_objects_checksum_check" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "job_attempts_org_job_idx" ON "job_attempts" ("organization_id","job_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_unique" ON "jobs" ("organization_id","job_type","idempotency_key") WHERE "idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" ("organization_id","status","next_attempt_at","priority","created_at");--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" ("organization_id","status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_queue_idx" ON "notification_deliveries" ("organization_id","status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_read_idx" ON "notifications" ("organization_id","recipient_user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "search_documents_owner_idx" ON "search_documents" ("organization_id","index_name","document_id");--> statement-breakpoint
CREATE INDEX "search_documents_fts_idx" ON "search_documents" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", '')));--> statement-breakpoint
CREATE INDEX "stored_objects_org_status_idx" ON "stored_objects" ("organization_id","status","created_at");--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "jobs"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_fk" FOREIGN KEY ("organization_id","notification_id") REFERENCES "notifications"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_membership_fk" FOREIGN KEY ("organization_id","recipient_user_id") REFERENCES "organization_memberships"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "jobs_tenant_branch_isolation" ON "jobs"
  USING (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  )
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  );
--> statement-breakpoint
ALTER TABLE "job_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "job_attempts_tenant_isolation" ON "job_attempts"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notifications_inbox_read" ON "notifications" FOR SELECT
  USING (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
    AND "recipient_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY "notifications_create" ON "notifications" FOR INSERT
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  );
--> statement-breakpoint
CREATE POLICY "notifications_inbox_update" ON "notifications" FOR UPDATE
  USING (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
    AND "recipient_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
    AND "recipient_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_deliveries_tenant_isolation" ON "notification_deliveries"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "stored_objects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stored_objects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "stored_objects_tenant_branch_isolation" ON "stored_objects"
  USING (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  )
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  );
--> statement-breakpoint
ALTER TABLE "search_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "search_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "search_documents_tenant_branch_isolation" ON "search_documents"
  USING (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  )
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  );
--> statement-breakpoint
GRANT USAGE ON TYPE "job_status", "notification_channel", "notification_delivery_status", "stored_object_provider", "stored_object_status" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "jobs", "job_attempts", "notifications", "notification_deliveries", "stored_objects", "search_documents" TO onecore_app;
--> statement-breakpoint
GRANT DELETE ON "search_documents" TO onecore_app;
--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system") VALUES
  ('core.organization.jobs.enqueue', 'core.organization', 'jobs', 'enqueue', 'Enqueue authorized organization platform jobs.', 'ACTIVE', true),
  ('core.organization.jobs.process', 'core.organization', 'jobs', 'process', 'Process organization platform jobs.', 'ACTIVE', true),
  ('core.organization.jobs.manage', 'core.organization', 'jobs', 'manage', 'Retry and cancel authorized organization platform jobs.', 'ACTIVE', true),
  ('core.organization.notification_inbox.read', 'core.organization', 'notification_inbox', 'read', 'Read the current user notification inbox.', 'ACTIVE', true),
  ('core.organization.notification_inbox.manage', 'core.organization', 'notification_inbox', 'manage', 'Create tenant-scoped in-app notifications.', 'ACTIVE', true),
  ('core.organization.storage.read', 'core.organization', 'storage', 'read', 'Read authorized tenant-owned object metadata and bytes.', 'ACTIVE', true),
  ('core.organization.storage.manage', 'core.organization', 'storage', 'manage', 'Create and delete tenant-owned objects.', 'ACTIVE', true),
  ('core.organization.search.read', 'core.organization', 'search', 'read', 'Search documents in the authorized organization.', 'ACTIVE', true),
  ('core.organization.search.manage', 'core.organization', 'search', 'manage', 'Index and remove tenant-owned search documents.', 'ACTIVE', true)
ON CONFLICT ("module_key", "resource_key", "action_key") DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE
  tenant_id uuid;
  target_role record;
  permission_row record;
  inserted_permission_id uuid;
BEGIN
  FOR tenant_id IN
    SELECT DISTINCT "organization_id"
    FROM "roles"
    WHERE "name" IN ('Organization Owner', 'Organization Admin')
      AND "is_system" = true
  LOOP
    PERFORM set_config('app.current_organization_id', tenant_id::text, true);
    FOR target_role IN
      SELECT "id", "name"
      FROM "roles"
      WHERE "organization_id" = tenant_id
        AND "name" IN ('Organization Owner', 'Organization Admin')
        AND "is_system" = true
    LOOP
      FOR permission_row IN
        SELECT "id", "key"
        FROM "permissions"
        WHERE "key" IN (
          'core.organization.jobs.enqueue',
          'core.organization.jobs.process',
          'core.organization.notification_inbox.read',
          'core.organization.notification_inbox.manage',
          'core.organization.storage.read',
          'core.organization.storage.manage',
          'core.organization.search.read',
          'core.organization.search.manage'
        )
      LOOP
        INSERT INTO "role_permissions" (
          "organization_id", "role_id", "permission_id", "scope_type", "scope"
        )
        VALUES (
          tenant_id, target_role."id", permission_row."id", 'ORGANIZATION', '{}'::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING "permission_id" INTO inserted_permission_id;
        IF FOUND THEN
          INSERT INTO "audit_logs" (
            "organization_id", "action", "resource", "resource_id", "result", "request_metadata"
          )
          VALUES (
            tenant_id,
            'ROLE_PERMISSION_GRANTED',
            'role_permission',
            target_role."id"::text || ':' || inserted_permission_id::text,
            'SUCCESS',
            jsonb_build_object(
              'source', 'phase_9_platform_services',
              'roleName', target_role."name",
              'permissionKey', permission_row."key"
            )
          );
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;