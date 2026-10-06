GRANT USAGE ON SCHEMA public TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "users" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE (
  "status",
  "failed_login_attempts",
  "failed_login_window_started_at",
  "locked_until",
  "last_login_at",
  "updated_at"
) ON "users" TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "sessions" TO onecore_app;
--> statement-breakpoint
GRANT INSERT (
  "secret_hash",
  "user_id",
  "organization_id",
  "branch_id",
  "created_at",
  "expires_at",
  "last_used_at",
  "ip_address",
  "user_agent"
) ON "sessions" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE (
  "organization_id",
  "branch_id",
  "last_used_at",
  "revoked_at"
) ON "sessions" TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "organization_memberships", "organizations", "branches",
  "membership_branches" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ON "audit_logs" TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "roles" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("organization_id", "name", "description")
  ON "roles" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("name", "description", "status", "updated_at")
  ON "roles" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "role_permissions", "membership_roles"
  TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "permissions", "membership_data_scopes",
  "platform_user_roles" TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "feature_flags" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "feature_flag_assignments" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "organization_settings",
  "business_settings", "organization_branding",
  "notification_configurations" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "custom_field_definitions",
  "integrations", "custom_domains" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "workflow_definitions",
  "workflow_versions", "workflow_steps", "workflow_triggers",
  "workflow_conditions", "workflow_actions", "workflow_transitions"
  TO onecore_app;
