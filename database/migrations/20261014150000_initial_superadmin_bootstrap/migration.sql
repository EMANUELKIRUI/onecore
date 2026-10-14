CREATE POLICY "platform_user_roles_migrator_read"
ON "platform_user_roles"
FOR SELECT
TO onecore_migrator
USING (current_user = 'onecore_migrator');