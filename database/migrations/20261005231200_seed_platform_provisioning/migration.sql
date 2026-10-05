CREATE POLICY "organizations_migrator_provision_read"
ON "organizations"
FOR SELECT
TO onecore_migrator
USING (current_user = 'onecore_migrator');
--> statement-breakpoint
CREATE POLICY "organizations_migrator_provision_insert"
ON "organizations"
FOR INSERT
TO onecore_migrator
WITH CHECK (current_user = 'onecore_migrator');
