CREATE TYPE "communication_channel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP', 'IN_APP');
--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "locale" varchar(35);
--> statement-breakpoint
CREATE TABLE "communication_provider_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "integration_id" uuid NOT NULL,
  "channel" "communication_channel" NOT NULL,
  "provider_key" varchar(80) NOT NULL,
  "status" varchar(20) DEFAULT 'DISABLED' NOT NULL,
  "configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "communication_provider_configs_org_id_unique" UNIQUE("organization_id", "id"),
  CONSTRAINT "communication_provider_configs_integration_unique" UNIQUE("organization_id", "integration_id"),
  CONSTRAINT "communication_provider_configs_integration_fk" FOREIGN KEY("organization_id", "integration_id") REFERENCES "integrations"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "communication_provider_configs_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "communication_provider_configs_configuration_size_check" CHECK (octet_length("configuration"::text) <= 16384)
);
--> statement-breakpoint
CREATE INDEX "communication_provider_configs_org_channel_idx" ON "communication_provider_configs" ("organization_id", "channel", "status");
--> statement-breakpoint
CREATE TABLE "communication_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "key" varchar(100) NOT NULL,
  "channel" "communication_channel" NOT NULL,
  "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "communication_templates_org_id_unique" UNIQUE("organization_id", "id"),
  CONSTRAINT "communication_templates_org_channel_key_unique" UNIQUE("organization_id", "channel", "key"),
  CONSTRAINT "communication_templates_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
CREATE INDEX "communication_templates_org_status_idx" ON "communication_templates" ("organization_id", "status");
--> statement-breakpoint
CREATE TABLE "communication_template_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "template_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "locale" varchar(35) NOT NULL,
  "subject" varchar(250),
  "body" text NOT NULL,
  "variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'DRAFT' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  CONSTRAINT "communication_template_versions_template_fk" FOREIGN KEY("organization_id", "template_id") REFERENCES "communication_templates"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "communication_template_versions_org_id_unique" UNIQUE("organization_id", "id"),
  CONSTRAINT "communication_template_versions_template_version_locale_unique" UNIQUE("organization_id", "template_id", "version", "locale"),
  CONSTRAINT "communication_template_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "communication_template_versions_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  CONSTRAINT "communication_template_versions_body_size_check" CHECK (octet_length("body") <= 16384 AND octet_length(coalesce("subject", '')) <= 1000 AND octet_length("variables"::text) <= 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "communication_template_versions_one_published_locale_idx" ON "communication_template_versions" ("organization_id", "template_id", "locale") WHERE "status" = 'PUBLISHED';
--> statement-breakpoint
CREATE FUNCTION protect_communication_template_version_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'PUBLISHED_COMMUNICATION_TEMPLATE_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'DRAFT' AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.template_id IS DISTINCT FROM OLD.template_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.locale IS DISTINCT FROM OLD.locale OR
    NEW.subject IS DISTINCT FROM OLD.subject OR
    NEW.body IS DISTINCT FROM OLD.body OR
    NEW.variables IS DISTINCT FROM OLD.variables OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_COMMUNICATION_TEMPLATE_IMMUTABLE';
  END IF;

  IF OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED' THEN
    RAISE EXCEPTION 'RETIRED_COMMUNICATION_TEMPLATE_IMMUTABLE';
  END IF;

  IF OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'INVALID_COMMUNICATION_TEMPLATE_TRANSITION';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER communication_template_versions_immutable_trigger BEFORE UPDATE OR DELETE ON "communication_template_versions" FOR EACH ROW EXECUTE FUNCTION protect_communication_template_version_history();
--> statement-breakpoint
CREATE INDEX "communication_template_versions_org_locale_status_idx" ON "communication_template_versions" ("organization_id", "locale", "status");
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid,
  "channel" "communication_channel" NOT NULL,
  "category" varchar(100) NOT NULL,
  "enabled" boolean NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_preferences_user_membership_fk" FOREIGN KEY("organization_id", "user_id") REFERENCES "organization_memberships"("organization_id", "user_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_org_default_unique" ON "notification_preferences" ("organization_id", "channel", "category") WHERE "user_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_unique" ON "notification_preferences" ("organization_id", "user_id", "channel", "category") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "notification_preferences_user_channel_idx" ON "notification_preferences" ("organization_id", "user_id", "channel");
--> statement-breakpoint
CREATE TABLE "communication_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "recipient_user_id" uuid NOT NULL,
  "channel" "communication_channel" NOT NULL,
  "category" varchar(100) NOT NULL,
  "template_version_id" uuid,
  "subject" varchar(250),
  "rendered_content" text NOT NULL,
  "content_hash_sha256" varchar(64) NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'QUEUED' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "correlation_id" uuid NOT NULL,
  "source_event_id" uuid,
  "idempotency_key" varchar(200),
  "created_by_user_id" uuid,
  "scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "communication_messages_org_id_unique" UNIQUE("organization_id", "id"),
  CONSTRAINT "communication_messages_recipient_membership_fk" FOREIGN KEY("organization_id", "recipient_user_id") REFERENCES "organization_memberships"("organization_id", "user_id") ON DELETE CASCADE,
  CONSTRAINT "communication_messages_template_version_fk" FOREIGN KEY("organization_id", "template_version_id") REFERENCES "communication_template_versions"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "communication_messages_source_event_fk" FOREIGN KEY("organization_id", "source_event_id") REFERENCES "outbox_events"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "communication_messages_creator_membership_fk" FOREIGN KEY("organization_id", "created_by_user_id") REFERENCES "organization_memberships"("organization_id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "communication_messages_status_check" CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED')),
  CONSTRAINT "communication_messages_content_size_check" CHECK (octet_length("rendered_content") <= 16384 AND octet_length(coalesce("subject", '')) <= 1000 AND octet_length("metadata"::text) <= 16384),
  CONSTRAINT "communication_messages_priority_check" CHECK ("priority" BETWEEN 0 AND 100),
  CONSTRAINT "communication_messages_content_hash_check" CHECK ("content_hash_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "communication_messages_idempotency_unique" ON "communication_messages" ("organization_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "communication_messages_org_status_schedule_idx" ON "communication_messages" ("organization_id", "status", "scheduled_at");
--> statement-breakpoint
CREATE INDEX "communication_messages_recipient_created_idx" ON "communication_messages" ("organization_id", "recipient_user_id", "created_at");
--> statement-breakpoint
CREATE TABLE "communication_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "provider_config_id" uuid,
  "status" varchar(20) DEFAULT 'QUEUED' NOT NULL,
  "provider_message_id" varchar(200),
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "last_failure_class" varchar(30),
  "last_failure_code" varchar(80),
  "retry_after_seconds" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "communication_deliveries_org_id_unique" UNIQUE("organization_id", "id"),
  CONSTRAINT "communication_deliveries_message_unique" UNIQUE("organization_id", "message_id"),
  CONSTRAINT "communication_deliveries_message_fk" FOREIGN KEY("organization_id", "message_id") REFERENCES "communication_messages"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "communication_deliveries_provider_config_fk" FOREIGN KEY("organization_id", "provider_config_id") REFERENCES "communication_provider_configs"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "communication_deliveries_status_check" CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED')),
  CONSTRAINT "communication_deliveries_attempts_check" CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
  CONSTRAINT "communication_deliveries_retry_after_check" CHECK ("retry_after_seconds" IS NULL OR "retry_after_seconds" BETWEEN 0 AND 86400)
);
--> statement-breakpoint
CREATE INDEX "communication_deliveries_queue_idx" ON "communication_deliveries" ("organization_id", "status", "next_attempt_at", "created_at");
--> statement-breakpoint
CREATE TABLE "communication_delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "delivery_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "status" varchar(20) NOT NULL,
  "provider_message_id" varchar(200),
  "failure_class" varchar(30),
  "failure_code" varchar(80),
  "retry_after_seconds" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "communication_delivery_attempts_delivery_fk" FOREIGN KEY("organization_id", "delivery_id") REFERENCES "communication_deliveries"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "communication_delivery_attempts_number_unique" UNIQUE("organization_id", "delivery_id", "attempt_number"),
  CONSTRAINT "communication_delivery_attempts_status_check" CHECK ("status" IN ('SENDING', 'SENT', 'DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTER')),
  CONSTRAINT "communication_delivery_attempts_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "communication_delivery_attempts_retry_after_check" CHECK ("retry_after_seconds" IS NULL OR "retry_after_seconds" BETWEEN 0 AND 86400)
);
--> statement-breakpoint
CREATE INDEX "communication_delivery_attempts_org_delivery_idx" ON "communication_delivery_attempts" ("organization_id", "delivery_id");
--> statement-breakpoint
ALTER TABLE "communication_provider_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communication_provider_configs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "communication_provider_configs_tenant_isolation" ON "communication_provider_configs" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "communication_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communication_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "communication_templates_tenant_isolation" ON "communication_templates" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "communication_template_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communication_template_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "communication_template_versions_tenant_isolation" ON "communication_template_versions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_preferences_tenant_isolation" ON "notification_preferences" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "communication_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communication_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "communication_messages_tenant_isolation" ON "communication_messages" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "communication_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communication_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "communication_deliveries_tenant_isolation" ON "communication_deliveries" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "communication_delivery_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communication_delivery_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "communication_delivery_attempts_tenant_isolation" ON "communication_delivery_attempts" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "communication_provider_configs", "communication_templates", "notification_preferences" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "communication_template_versions", "communication_messages", "communication_deliveries", "communication_delivery_attempts" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("locale") ON "organization_memberships" TO onecore_app;
--> statement-breakpoint
INSERT INTO "permissions" (
  "id",
  "key",
  "module_key",
  "resource_key",
  "action_key",
  "description",
  "is_system"
) VALUES
  (gen_random_uuid(), 'core.organization.notification_inbox.update_self', 'core.organization', 'notification_inbox', 'update_self', 'Update the current user''s own notification read state.', true),
  (gen_random_uuid(), 'core.organization.notification_preferences.read_self', 'core.organization', 'notification_preferences', 'read_self', 'Read the current user''s own communication preferences.', true),
  (gen_random_uuid(), 'core.organization.notification_preferences.update_self', 'core.organization', 'notification_preferences', 'update_self', 'Update the current user''s own communication preferences.', true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id")
SELECT roles.organization_id, roles.id, permissions.id
FROM "roles"
CROSS JOIN "permissions"
WHERE roles.status = 'ACTIVE'
  AND roles.name IN ('Organization Owner', 'Organization Admin', 'Manager', 'Staff', 'Viewer')
  AND permissions.key IN (
    'core.organization.notification_inbox.read',
    'core.organization.notification_inbox.update_self',
    'core.organization.notification_preferences.read_self',
    'core.organization.notification_preferences.update_self'
  )
ON CONFLICT DO NOTHING;
