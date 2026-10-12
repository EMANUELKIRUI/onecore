CREATE TABLE "user_mfa_credentials" (
	"user_id" uuid PRIMARY KEY,
	"secret_encrypted" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"enrollment_expires_at" timestamp with time zone NOT NULL,
	"last_totp_step" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_mfa_credentials_secret_nonempty" CHECK (length("secret_encrypted") > 0),
	CONSTRAINT "user_mfa_credentials_last_step_nonnegative" CHECK ("last_totp_step" IS NULL OR "last_totp_step" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_mfa_credentials" ADD CONSTRAINT "user_mfa_credentials_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "user_mfa_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_mfa_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_mfa_credentials_identity_scope" ON "user_mfa_credentials"
  FOR ALL
  USING ("user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_mfa_credentials" TO onecore_app;