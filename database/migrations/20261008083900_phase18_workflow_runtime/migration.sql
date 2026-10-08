ALTER TABLE "workflow_actions"
  ADD CONSTRAINT "workflow_actions_org_id_id_unique"
  UNIQUE ("organization_id", "id");
--> statement-breakpoint
ALTER TABLE "workflow_executions"
  ADD COLUMN "source_event_id" uuid,
  ADD COLUMN "branch_id" uuid,
  ADD COLUMN "failure_code" varchar(100);
--> statement-breakpoint
ALTER TABLE "workflow_executions"
  ADD CONSTRAINT "workflow_executions_org_id_id_unique"
    UNIQUE ("organization_id", "id"),
  ADD CONSTRAINT "workflow_executions_source_event_fk"
    FOREIGN KEY ("organization_id", "source_event_id")
    REFERENCES "outbox_events" ("organization_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "workflow_executions_branch_fk"
    FOREIGN KEY ("organization_id", "branch_id")
    REFERENCES "branches" ("organization_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "workflow_executions_status_check"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  ADD CONSTRAINT "workflow_executions_failure_code_check"
    CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[A-Z0-9_]{1,100}$');
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_event_version_unique"
  ON "workflow_executions" ("organization_id", "workflow_version_id", "source_event_id")
  WHERE "source_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "workflow_executions_org_branch_started_idx"
  ON "workflow_executions" ("organization_id", "branch_id", "started_at");
--> statement-breakpoint
CREATE TABLE "workflow_execution_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "execution_id" uuid NOT NULL,
  "workflow_action_id" uuid NOT NULL,
  "status" varchar(20) DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "failure_code" varchar(100),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_execution_actions_execution_fk"
    FOREIGN KEY ("organization_id", "execution_id")
    REFERENCES "workflow_executions" ("organization_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "workflow_execution_actions_action_fk"
    FOREIGN KEY ("organization_id", "workflow_action_id")
    REFERENCES "workflow_actions" ("organization_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "workflow_execution_actions_action_unique"
    UNIQUE ("organization_id", "execution_id", "workflow_action_id"),
  CONSTRAINT "workflow_execution_actions_status_check"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  CONSTRAINT "workflow_execution_actions_attempts_check"
    CHECK ("attempts" BETWEEN 0 AND 20),
  CONSTRAINT "workflow_execution_actions_failure_code_check"
    CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[A-Z0-9_]{1,100}$')
);
--> statement-breakpoint
CREATE INDEX "workflow_execution_actions_org_status_idx"
  ON "workflow_execution_actions" ("organization_id", "execution_id", "status");
--> statement-breakpoint
ALTER TABLE "workflow_execution_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_execution_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_execution_actions_tenant_isolation"
  ON "workflow_execution_actions"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "workflow_executions",
  "workflow_execution_actions" TO onecore_app;
--> statement-breakpoint
GRANT SELECT (
  "id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "organization_id",
  "branch_id",
  "actor_user_id",
  "correlation_id",
  "causation_id",
  "occurred_at",
  "payload",
  "metadata",
  "version"
) ON "outbox_events" TO onecore_app;
