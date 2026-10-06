ALTER TABLE "jobs" ADD COLUMN "request_hash" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "correlation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "causation_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$');