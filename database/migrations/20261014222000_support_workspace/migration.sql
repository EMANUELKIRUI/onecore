CREATE TABLE "support_root_administrators" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "provisioned_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "support_access_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "support_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "granted_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" varchar(500) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "support_access_grants_reason_nonempty" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "support_access_grants_expiry_after_creation" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX "support_access_grants_user_org_expiry_idx"
  ON "support_access_grants" ("support_user_id", "organization_id", "expires_at");
--> statement-breakpoint
CREATE TABLE "support_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "assigned_support_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "status" varchar(20) NOT NULL DEFAULT 'OPEN',
  "priority" varchar(10) NOT NULL DEFAULT 'NORMAL',
  "subject" varchar(200) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  CONSTRAINT "support_requests_status_check"
    CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED')),
  CONSTRAINT "support_requests_priority_check"
    CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT "support_requests_subject_nonempty" CHECK (length(btrim("subject")) > 0),
  CONSTRAINT "support_requests_org_id_id_unique" UNIQUE ("organization_id", "id")
);
--> statement-breakpoint
CREATE INDEX "support_requests_org_updated_idx" ON "support_requests" ("organization_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "support_requests_assigned_updated_idx" ON "support_requests" ("assigned_support_user_id", "updated_at");
--> statement-breakpoint
CREATE TABLE "support_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "author_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "visibility" varchar(10) NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "support_messages_request_fk" FOREIGN KEY ("organization_id", "request_id")
    REFERENCES "support_requests" ("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "support_messages_visibility_check" CHECK ("visibility" IN ('CUSTOMER', 'INTERNAL')),
  CONSTRAINT "support_messages_body_nonempty" CHECK (length(btrim("body")) > 0)
);
--> statement-breakpoint
CREATE INDEX "support_messages_request_created_idx" ON "support_messages" ("organization_id", "request_id", "created_at");
--> statement-breakpoint
ALTER TABLE "support_root_administrators" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_root_administrators" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "support_root_administrators_self_read" ON "support_root_administrators"
  FOR SELECT USING ("user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "support_root_administrators_migrator_read" ON "support_root_administrators"
  FOR SELECT TO onecore_migrator USING (current_user = 'onecore_migrator');
--> statement-breakpoint
CREATE POLICY "support_root_administrators_migrator_insert" ON "support_root_administrators"
  FOR INSERT TO onecore_migrator
  WITH CHECK (current_user = 'onecore_migrator');
--> statement-breakpoint
ALTER TABLE "support_access_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_access_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "support_access_grants_scoped_read" ON "support_access_grants"
  FOR SELECT USING (
    "support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND "revoked_at" IS NULL AND "expires_at" > now()
    OR EXISTS (
      SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint
CREATE POLICY "support_access_grants_root_manage" ON "support_access_grants"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint
ALTER TABLE "support_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "support_requests_customer_or_assigned_read" ON "support_requests"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "organization_memberships" membership
      WHERE membership."organization_id" = "support_requests"."organization_id"
        AND membership."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND membership."status" = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM "organizations" organization
          WHERE organization."id" = membership."organization_id"
            AND organization."status" = 'ACTIVE')
    )
    OR (
      "assigned_support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (SELECT 1 FROM "platform_user_roles" platform_role
        WHERE platform_role."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
          AND platform_role."role" = 'SUPPORT')
      AND EXISTS (SELECT 1 FROM "support_access_grants" access_grant
        WHERE access_grant."organization_id" = "support_requests"."organization_id"
          AND access_grant."support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
          AND access_grant."revoked_at" IS NULL AND access_grant."expires_at" > now())
    )
  );
--> statement-breakpoint
CREATE POLICY "support_requests_root_read" ON "support_requests"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid)
  );
--> statement-breakpoint
CREATE POLICY "support_requests_customer_create" ON "support_requests"
  FOR INSERT WITH CHECK (
    "created_by_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND "assigned_support_user_id" IS NULL AND "status" = 'OPEN'
    AND EXISTS (
      SELECT 1 FROM "organization_memberships" membership
      WHERE membership."organization_id" = "support_requests"."organization_id"
        AND membership."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND membership."status" = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM "organizations" organization
          WHERE organization."id" = membership."organization_id"
            AND organization."status" = 'ACTIVE')
    )
  );
--> statement-breakpoint
CREATE POLICY "organizations_support_grant_read" ON "organizations"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "support_access_grants" access_grant
      JOIN "platform_user_roles" platform_role
        ON platform_role."user_id" = access_grant."support_user_id"
       AND platform_role."role" = 'SUPPORT'
      WHERE access_grant."organization_id" = "organizations"."id"
        AND access_grant."support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND access_grant."revoked_at" IS NULL AND access_grant."expires_at" > now()
    )
  );
--> statement-breakpoint
CREATE POLICY "support_requests_assigned_staff_update" ON "support_requests"
  FOR UPDATE USING (
    "assigned_support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM "platform_user_roles" platform_role
      WHERE platform_role."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND platform_role."role" = 'SUPPORT')
    AND EXISTS (SELECT 1 FROM "support_access_grants" access_grant
      WHERE access_grant."organization_id" = "support_requests"."organization_id"
        AND access_grant."support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND access_grant."revoked_at" IS NULL AND access_grant."expires_at" > now())
  ) WITH CHECK (
    "assigned_support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM "support_access_grants" access_grant
      WHERE access_grant."organization_id" = "support_requests"."organization_id"
        AND access_grant."support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND access_grant."revoked_at" IS NULL AND access_grant."expires_at" > now())
  );
--> statement-breakpoint
CREATE POLICY "support_requests_root_assignment" ON "support_requests"
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid)
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid)
  );
--> statement-breakpoint
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "support_messages_scoped_read" ON "support_messages"
  FOR SELECT USING (
    ("visibility" = 'CUSTOMER' AND EXISTS (
      SELECT 1 FROM "organization_memberships" membership
      WHERE membership."organization_id" = "support_messages"."organization_id"
        AND membership."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND membership."status" = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM "organizations" organization
          WHERE organization."id" = membership."organization_id"
            AND organization."status" = 'ACTIVE')
    ))
    OR EXISTS (
      SELECT 1 FROM "support_requests" request
      WHERE request."id" = "support_messages"."request_id"
        AND request."organization_id" = "support_messages"."organization_id"
        AND request."assigned_support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM "platform_user_roles" platform_role
          WHERE platform_role."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
            AND platform_role."role" = 'SUPPORT')
        AND EXISTS (SELECT 1 FROM "support_access_grants" access_grant
          WHERE access_grant."organization_id" = request."organization_id"
            AND access_grant."support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
            AND access_grant."revoked_at" IS NULL AND access_grant."expires_at" > now())
    )
  );
--> statement-breakpoint
CREATE POLICY "support_messages_authorized_insert" ON "support_messages"
  FOR INSERT WITH CHECK (
    "author_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "support_requests" request
      WHERE request."id" = "support_messages"."request_id"
        AND request."organization_id" = "support_messages"."organization_id"
        AND (
          ("visibility" = 'CUSTOMER' AND EXISTS (
            SELECT 1 FROM "organization_memberships" membership
            WHERE membership."organization_id" = request."organization_id"
              AND membership."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
              AND membership."status" = 'ACTIVE'
              AND EXISTS (SELECT 1 FROM "organizations" organization
                WHERE organization."id" = membership."organization_id"
                  AND organization."status" = 'ACTIVE')
          ))
          OR (request."assigned_support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM "platform_user_roles" platform_role
              WHERE platform_role."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
                AND platform_role."role" = 'SUPPORT')
            AND EXISTS (SELECT 1 FROM "support_access_grants" access_grant
              WHERE access_grant."organization_id" = request."organization_id"
                AND access_grant."support_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
                AND access_grant."revoked_at" IS NULL AND access_grant."expires_at" > now())
            AND ("visibility" = 'CUSTOMER' OR EXISTS (
              SELECT 1 FROM "platform_user_roles" platform_role
              WHERE platform_role."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid
                AND platform_role."role" = 'SUPPORT'
            )))
        )
    )
  );
--> statement-breakpoint
CREATE POLICY "platform_user_roles_root_support_manage" ON "platform_user_roles"
  FOR ALL USING (
    "role" = 'SUPPORT'
    AND
    EXISTS (SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid)
  ) WITH CHECK (
    "role" = 'SUPPORT'
    AND
    EXISTS (SELECT 1 FROM "support_root_administrators" root_admin
      WHERE root_admin."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid)
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_requests" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "support_messages" TO onecore_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_access_grants" TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "support_access_grants" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT ON "support_root_administrators" TO onecore_app;
--> statement-breakpoint
GRANT SELECT ON "support_root_administrators" TO onecore_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON "support_root_administrators" TO onecore_migrator;
--> statement-breakpoint
GRANT INSERT, DELETE ON "platform_user_roles" TO onecore_app;
