UPDATE "users" SET "email" = lower("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" (lower("email"));