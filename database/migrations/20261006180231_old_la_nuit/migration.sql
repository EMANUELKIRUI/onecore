ALTER TABLE "rate_limit_buckets" ADD COLUMN "branch_id" uuid;
--> statement-breakpoint
DROP POLICY "rate_limit_buckets_scope_isolation" ON "rate_limit_buckets";
--> statement-breakpoint
CREATE POLICY "rate_limit_buckets_scope_isolation" ON "rate_limit_buckets"
  USING (
    (
      "organization_id" IS NULL
      AND "branch_id" IS NULL
      AND nullif(current_setting('app.current_organization_id', true), '') IS NULL
      AND nullif(current_setting('app.current_branch_id', true), '') IS NULL
    )
    OR (
      "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
      AND "branch_id" IS NOT DISTINCT FROM nullif(current_setting('app.current_branch_id', true), '')::uuid
    )
  )
  WITH CHECK (
    (
      "organization_id" IS NULL
      AND "branch_id" IS NULL
      AND nullif(current_setting('app.current_organization_id', true), '') IS NULL
      AND nullif(current_setting('app.current_branch_id', true), '') IS NULL
    )
    OR (
      "organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
      AND "branch_id" IS NOT DISTINCT FROM nullif(current_setting('app.current_branch_id', true), '')::uuid
    )
  );