CREATE TABLE "rate_limit_buckets" (
	"key_hash" varchar(64) PRIMARY KEY,
	"organization_id" uuid,
	"hit_count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_hash_check" CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rate_limit_buckets_hits_check" CHECK ("hit_count" > 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expiry_idx" ON "rate_limit_buckets" ("expires_at");
--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rate_limit_buckets_scope_isolation" ON "rate_limit_buckets"
  USING (
    ("organization_id" IS NULL AND nullif(current_setting('app.current_organization_id', true), '') IS NULL)
    OR "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    ("organization_id" IS NULL AND nullif(current_setting('app.current_organization_id', true), '') IS NULL)
    OR "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_buckets" TO onecore_app;