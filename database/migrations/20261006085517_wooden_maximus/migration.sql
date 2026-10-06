CREATE TABLE "event_dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" varchar(150) NOT NULL,
	"handler_name" varchar(150) NOT NULL,
	"failure_kind" varchar(40) NOT NULL,
	"failure_reason" varchar(2000) NOT NULL,
	"attempts" integer NOT NULL,
	"dead_lettered_at" timestamp with time zone NOT NULL,
	"replayed_at" timestamp with time zone,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_dead_letters_event_handler_unique" UNIQUE("event_id","handler_name"),
	CONSTRAINT "event_dead_letters_attempts_nonnegative" CHECK ("attempts" >= 0 and "replay_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "event_processing_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" varchar(150) NOT NULL,
	"handler_name" varchar(150) NOT NULL,
	"event_version" integer NOT NULL,
	"status" varchar(20) DEFAULT 'PROCESSING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"failure_kind" varchar(40),
	"last_error" varchar(2000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_processing_records_event_handler_unique" UNIQUE("event_id","handler_name"),
	CONSTRAINT "event_processing_records_attempts_nonnegative" CHECK ("attempts" >= 0),
	CONSTRAINT "event_processing_records_status_check" CHECK ("status" in ('PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED'))
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "aggregate_type" varchar(100) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "causation_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "metadata" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "delivery_status" varchar(20) DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "last_error" varchar(2000);--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DROP INDEX "outbox_events_pending_idx";--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("organization_id","delivery_status","next_attempt_at","created_at");--> statement-breakpoint
DROP INDEX "outbox_events_aggregate_idx";--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" ("organization_id","aggregate_id","occurred_at");--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_org_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE INDEX "event_dead_letters_org_time_idx" ON "event_dead_letters" ("organization_id","dead_lettered_at");--> statement-breakpoint
CREATE INDEX "event_processing_records_org_status_idx" ON "event_processing_records" ("organization_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_events_type_idx" ON "outbox_events" ("organization_id","event_type","created_at");--> statement-breakpoint
ALTER TABLE "event_dead_letters" ADD CONSTRAINT "event_dead_letters_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "event_dead_letters" ADD CONSTRAINT "event_dead_letters_outbox_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "outbox_events"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "event_processing_records" ADD CONSTRAINT "event_processing_records_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "event_processing_records" ADD CONSTRAINT "event_processing_records_outbox_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "outbox_events"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_actor_user_id_users_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_attempts_nonnegative" CHECK ("attempts" >= 0);--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_delivery_status_check" CHECK ("delivery_status" in ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTERED'));
--> statement-breakpoint
ALTER TABLE "event_processing_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_processing_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "event_processing_records_tenant_isolation" ON "event_processing_records" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "event_dead_letters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_dead_letters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "event_dead_letters_tenant_isolation" ON "event_dead_letters" USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE FUNCTION "prevent_outbox_event_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'outbox events are retained and cannot be deleted';
	END IF;
	IF ROW(
		NEW."id", NEW."event_type", NEW."aggregate_type", NEW."aggregate_id",
		NEW."organization_id", NEW."branch_id", NEW."actor_user_id",
		NEW."correlation_id", NEW."causation_id", NEW."occurred_at",
		NEW."payload", NEW."metadata", NEW."version", NEW."created_at"
	) IS DISTINCT FROM ROW(
		OLD."id", OLD."event_type", OLD."aggregate_type", OLD."aggregate_id",
		OLD."organization_id", OLD."branch_id", OLD."actor_user_id",
		OLD."correlation_id", OLD."causation_id", OLD."occurred_at",
		OLD."payload", OLD."metadata", OLD."version", OLD."created_at"
	) THEN
		RAISE EXCEPTION 'outbox event envelopes are immutable';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "outbox_events_immutable_envelope" BEFORE UPDATE OR DELETE ON "outbox_events" FOR EACH ROW EXECUTE FUNCTION "prevent_outbox_event_mutation"();--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system") VALUES
('core.organization.events.read', 'core.organization', 'events', 'read', 'Inspect organization event delivery and dead letters.', 'ACTIVE', true),
('core.organization.events.manage', 'core.organization', 'events', 'manage', 'Dispatch and replay organization events.', 'ACTIVE', true)
ON CONFLICT ("module_key", "resource_key", "action_key") DO NOTHING;--> statement-breakpoint
DO $$
DECLARE
	tenant_id uuid;
	role_row record;
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
		FOR role_row IN
			SELECT "id", "name"
			FROM "roles"
			WHERE "organization_id" = tenant_id
				AND "name" IN ('Organization Owner', 'Organization Admin')
				AND "is_system" = true
		LOOP
			FOR permission_row IN
				SELECT "id", "key"
				FROM "permissions"
				WHERE "key" IN ('core.organization.events.read', 'core.organization.events.manage')
			LOOP
				INSERT INTO "role_permissions" (
					"organization_id", "role_id", "permission_id", "scope_type", "scope"
				) VALUES (
					tenant_id, role_row."id", permission_row."id", 'ORGANIZATION', '{}'::jsonb
				)
				ON CONFLICT DO NOTHING
				RETURNING "permission_id" INTO inserted_permission_id;
				IF FOUND THEN
					INSERT INTO "audit_logs" (
						"organization_id", "action", "resource", "resource_id", "result", "request_metadata"
					) VALUES (
						tenant_id,
						'ROLE_PERMISSION_GRANTED',
						'role_permission',
						role_row."id"::text || ':' || inserted_permission_id::text,
						'SUCCESS',
						jsonb_build_object(
							'source', 'phase_8_event_permissions',
							'roleName', role_row."name",
							'permissionKey', permission_row."key"
						)
					);
				END IF;
			END LOOP;
		END LOOP;
	END LOOP;
	PERFORM set_config('app.current_organization_id', '', true);
END $$;