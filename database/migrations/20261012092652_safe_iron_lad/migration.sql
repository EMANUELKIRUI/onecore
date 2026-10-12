ALTER TABLE "sessions" ADD COLUMN "mfa_verified_at" timestamp with time zone;
--> statement-breakpoint
GRANT INSERT ("mfa_verified_at") ON "sessions" TO onecore_app;