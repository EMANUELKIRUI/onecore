REVOKE INSERT ON "organizations" FROM onecore_app;
--> statement-breakpoint
GRANT INSERT ("id", "name", "slug", "industry", "status", "deployment_type", "profile", "created_at", "updated_at")
  ON "organizations" TO onecore_app;
