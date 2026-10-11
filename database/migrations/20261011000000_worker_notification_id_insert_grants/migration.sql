GRANT INSERT ("id", "read_at", "created_at")
  ON "notifications" TO onecore_worker;
GRANT INSERT ("id", "next_attempt_at", "last_error_code", "created_at", "updated_at")
  ON "notification_deliveries" TO onecore_worker;
