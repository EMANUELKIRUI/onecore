ALTER TABLE "custom_development_approvals" DROP CONSTRAINT "custom_development_approvals_quote_id_custom_development_quotes_id_fk";
--> statement-breakpoint
ALTER TABLE "custom_development_requests" DROP CONSTRAINT "custom_development_requests_requester_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "custom_development_quotes" ADD CONSTRAINT "custom_development_quotes_org_id_id_unique" UNIQUE("organization_id","id");
--> statement-breakpoint
ALTER TABLE "custom_development_approvals" ADD CONSTRAINT "custom_development_approvals_quote_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."custom_development_quotes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_development_requests" ADD CONSTRAINT "custom_development_requests_requester_membership_fk" FOREIGN KEY ("organization_id","requester_user_id") REFERENCES "public"."organization_memberships"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;