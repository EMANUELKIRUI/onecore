CREATE TABLE "owner_credential_setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL UNIQUE,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "owner_credential_setup_tokens_hash_format" CHECK ("token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "owner_credential_setup_tokens_expiry_after_creation" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "owner_credential_setup_tokens_terminal_state" CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE INDEX "owner_credential_setup_tokens_user_org_idx" ON "owner_credential_setup_tokens" ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "owner_credential_setup_tokens_expiry_idx" ON "owner_credential_setup_tokens" ("expires_at");--> statement-breakpoint
ALTER TABLE "owner_credential_setup_tokens" ADD CONSTRAINT "owner_credential_setup_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "owner_credential_setup_tokens" ADD CONSTRAINT "owner_credential_setup_tokens_n0jFiXMql3F3_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "owner_credential_setup_tokens" ADD CONSTRAINT "owner_credential_setup_tokens_created_by_user_id_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owner_credential_setup_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "owner_credential_setup_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "owner_credential_setup_tokens_identity_scope"
  ON "owner_credential_setup_tokens"
  FOR ALL
  USING (
    "token_hash" = nullif(current_setting('app.owner_setup_token_hash', true), '')
    OR "user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    OR "created_by_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    "token_hash" = nullif(current_setting('app.owner_setup_token_hash', true), '')
    OR "user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    OR "created_by_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
GRANT SELECT, INSERT ON "owner_credential_setup_tokens" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("consumed_at", "revoked_at")
  ON "owner_credential_setup_tokens" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("password_hash", "email_verified_at")
  ON "users" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("status") ON "organization_memberships" TO onecore_app;