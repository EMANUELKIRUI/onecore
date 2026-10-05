CREATE TYPE "branch_status" AS ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "membership_branch_access_mode" AS ENUM('ASSIGNED', 'ALL');--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "branch_access_mode" "membership_branch_access_mode" DEFAULT 'ASSIGNED'::"membership_branch_access_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "status" SET DATA TYPE "branch_status" USING upper("status")::"branch_status";--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"branch_status";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;