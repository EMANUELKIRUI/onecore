CREATE POLICY "platform_user_roles_migrator_insert"
ON "platform_user_roles"
FOR INSERT
WITH CHECK (current_user = 'onecore_migrator');
