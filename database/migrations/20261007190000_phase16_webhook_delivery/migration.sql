CREATE TABLE "webhook_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "integration_id" uuid NOT NULL,
  "endpoint_url" varchar(2048) NOT NULL,
  "description" varchar(256),
  "event_types" jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'DISABLED' NOT NULL,
  "signing_secret_reference" varchar(500),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "webhook_subscriptions_org_id_unique" UNIQUE("organization_id", "id"),
  CONSTRAINT "webhook_subscriptions_integration_fk" FOREIGN KEY("organization_id", "integration_id") REFERENCES "integrations"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "webhook_subscriptions_event_types_check" CHECK (jsonb_typeof("event_types") = 'array' AND jsonb_array_length("event_types") BETWEEN 1 AND 100),
  CONSTRAINT "webhook_subscriptions_endpoint_https_check" CHECK ("endpoint_url" LIKE 'https://%'),
  CONSTRAINT "webhook_subscriptions_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "webhook_subscriptions_active_secret_check" CHECK ("status" <> 'ACTIVE' OR "signing_secret_reference" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_status_idx" ON "webhook_subscriptions" ("organization_id", "status");
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" varchar(150) NOT NULL,
  "status" varchar(20) DEFAULT 'PENDING' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 8 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "last_http_status" integer,
  "last_failure_code" varchar(80),
  "response_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "webhook_deliveries_org_id_unique" UNIQUE("organization_id", "id"),
  CONSTRAINT "webhook_deliveries_event_subscription_unique" UNIQUE("event_id", "subscription_id"),
  CONSTRAINT "webhook_deliveries_subscription_fk" FOREIGN KEY("organization_id", "subscription_id") REFERENCES "webhook_subscriptions"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "webhook_deliveries_outbox_fk" FOREIGN KEY("organization_id", "event_id") REFERENCES "outbox_events"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "webhook_deliveries_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'RETRYING', 'DELIVERED', 'DEAD_LETTERED', 'CANCELLED')),
  CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
  CONSTRAINT "webhook_deliveries_response_metadata_size_check" CHECK (octet_length("response_metadata"::text) <= 4096)
);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_status_retry_idx" ON "webhook_deliveries" ("organization_id", "status", "next_attempt_at");
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "delivery_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "status" varchar(20) NOT NULL,
  "http_status" integer,
  "failure_code" varchar(80),
  "response_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "webhook_delivery_attempts_delivery_fk" FOREIGN KEY("organization_id", "delivery_id") REFERENCES "webhook_deliveries"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "webhook_delivery_attempts_delivery_number_unique" UNIQUE("delivery_id", "attempt_number"),
  CONSTRAINT "webhook_delivery_attempts_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "webhook_delivery_attempts_status_check" CHECK ("status" IN ('IN_PROGRESS', 'CANCELLED', 'DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTERED')),
  CONSTRAINT "webhook_delivery_attempts_response_metadata_size_check" CHECK (octet_length("response_metadata"::text) <= 4096)
);
--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_org_delivery_idx" ON "webhook_delivery_attempts" ("organization_id", "delivery_id");
--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "webhook_subscriptions_tenant_isolation" ON "webhook_subscriptions" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant_isolation" ON "webhook_deliveries" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "webhook_delivery_attempts_tenant_isolation" ON "webhook_delivery_attempts" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_subscriptions" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "webhook_deliveries", "webhook_delivery_attempts" TO onecore_app;