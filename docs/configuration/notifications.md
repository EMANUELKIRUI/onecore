# Notification preferences

`notification_configurations` provides one organization-scoped preference document protected by forced RLS. Authorized GET/PATCH APIs validate event names, the `IN_APP`, `EMAIL`, `SMS`, `WHATSAPP`, and `WEBHOOK` channel set, enabled state, and allow-listed recipient modes. Per-event branch overrides are accepted only when the branch matches the server-verified session context. Mutations require `core.organization.notifications.manage` and are audited.

Preferences configure dispatch only; no messaging provider or dispatcher is implemented. Secret provider credentials belong in a secret manager and never in this document. Audits record event counts, not message content, recipients, or credentials.
