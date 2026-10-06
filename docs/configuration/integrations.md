# Integration metadata

`integrations` stores organization-scoped provider identity, status, and non-secret configuration under forced RLS. Authorized GET/POST/PATCH/DELETE APIs support payment-gateway, email, SMS, WhatsApp, accounting, webhook, and storage metadata. `core.organization.integrations.read/manage` protects access. The API does not accept secret values or secret references and sanitizes existing configuration JSON through a strict allow-list before returning it.

No provider execution or secret-management system is implemented. Do not persist plaintext credentials. A future integration service must resolve secrets only at the provider boundary and redact them from logs and audit records. Webhooks require signature validation and replay protection.

`custom_domains` globally uniquifies normalized domain names, stores verification/SSL metadata, and permits one primary domain per organization. Authorized GET/POST/PATCH/DELETE APIs are available through `core.organization.domains.read/manage`. New domains remain `PENDING`; only a previously verified domain can be primary. DNS ownership verification and SSL provisioning are not implemented.
