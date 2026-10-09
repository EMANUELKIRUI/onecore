CREATE POLICY "organizations_worker_discovery"
  ON "organizations"
  FOR SELECT
  TO onecore_worker
  USING ("status" = 'ACTIVE');
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO onecore_worker;
--> statement-breakpoint
GRANT USAGE ON TYPE "job_status", "notification_channel",
  "notification_delivery_status" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ("id", "status") ON "organizations" TO onecore_worker;
--> statement-breakpoint
GRANT UPDATE ("status") ON "organizations" TO onecore_worker;
--> statement-breakpoint
CREATE POLICY "organizations_worker_no_update"
  ON "organizations"
  AS RESTRICTIVE
  FOR UPDATE
  TO onecore_worker
  USING (true)
  WITH CHECK (false);
--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "status", "name", "code")
  ON "branches" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "user_id", "status", "branch_access_mode")
  ON "organization_memberships" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ("id", "status") ON "users" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT (
  "id", "user_id", "organization_id", "branch_id", "expires_at", "revoked_at"
) ON "sessions" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ON "membership_branches", "membership_roles", "roles",
  "role_permissions", "permissions", "membership_data_scopes",
  "platform_user_roles" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ON "modules", "module_versions", "module_dependencies",
  "organization_modules", "subscriptions", "subscription_items",
  "plans", "plan_modules" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ON "workflow_definitions", "workflow_versions",
  "workflow_steps", "workflow_triggers", "workflow_conditions",
  "workflow_actions", "workflow_transitions" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "workflow_executions",
  "workflow_execution_actions" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ON "jobs" TO onecore_worker;
--> statement-breakpoint
GRANT UPDATE (
  "status", "attempts", "next_attempt_at", "lease_owner", "lease_token",
  "lease_expires_at", "started_at", "completed_at", "failed_at",
  "last_error_code", "updated_at"
) ON "jobs" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "job_attempts" TO onecore_worker;
--> statement-breakpoint
GRANT INSERT (
  "id", "organization_id", "actor_user_id", "action", "resource",
  "resource_id", "occurred_at", "request_metadata", "before_state",
  "after_state", "result"
) ON "audit_logs" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT (
  "id", "event_type", "aggregate_type", "aggregate_id", "organization_id",
  "branch_id", "actor_user_id", "correlation_id", "causation_id",
  "occurred_at", "payload", "metadata", "version"
) ON "outbox_events" TO onecore_worker;
--> statement-breakpoint
GRANT INSERT (
  "id", "event_type", "aggregate_type", "aggregate_id", "organization_id",
  "branch_id", "actor_user_id", "correlation_id", "causation_id",
  "occurred_at", "payload", "metadata", "version", "delivery_status",
  "next_attempt_at"
) ON "outbox_events" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ON "notification_preferences" TO onecore_worker;
--> statement-breakpoint
CREATE POLICY "notifications_worker_insert_returning"
  ON "notifications"
  FOR SELECT
  TO onecore_worker
  USING (
    "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
    AND ("branch_id" IS NULL OR "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid)
  );
--> statement-breakpoint
GRANT SELECT ("id") ON "notifications" TO onecore_worker;
--> statement-breakpoint
GRANT INSERT (
  "organization_id", "branch_id", "recipient_user_id", "created_by_user_id",
  "notification_type", "title", "body", "metadata"
) ON "notifications" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ("id") ON "notifications" TO onecore_worker;
--> statement-breakpoint
GRANT INSERT (
  "organization_id", "notification_id", "channel", "status", "attempts",
  "delivered_at"
) ON "notification_deliveries" TO onecore_worker;
