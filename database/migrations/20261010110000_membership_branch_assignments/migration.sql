GRANT INSERT (
  "organization_id", "membership_id", "branch_id", "created_at"
)
  ON "membership_branches" TO onecore_app;
--> statement-breakpoint
GRANT DELETE ON "membership_branches" TO onecore_app;