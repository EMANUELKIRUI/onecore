# Integrations and webhooks

## Integration metadata

`integrations` stores organization-scoped provider identity, non-secret
configuration, metadata status, and an opaque secret reference under forced
RLS. Existing GET/POST/PATCH/DELETE APIs use
`core.organization.integrations.read/manage`, verified tenant transactions,
safe audit metadata, and the transactional `CONFIGURATION_CHANGED` event.
Secret-shaped fields are rejected from ordinary metadata requests, and API
responses expose only `hasCredentials`, never a secret or reference. `PENDING`
is metadata-only; no provider connection or health lifecycle is implied.

## Credentials

The typed `SecretStore` port supports store, rotate, callback-only use, delete,
and metadata lookup, with organization and purpose required on each request.
Credential create/rotate/revoke routes use existing integration authorization
and return only configured/version metadata. Credential references and values
are excluded from audit and event payloads. The default `unavailableSecretStore`
fails closed; no database/plaintext or environment fallback exists. A
deployment must inject an approved secret manager/KMS adapter before these
operations can succeed. Secret storage and PostgreSQL mutations cannot share a
distributed transaction, so a production adapter must be idempotent and
provide orphan-version cleanup.

## Webhook subscriptions and delivery

An organization-scoped webhook subscription references a same-organization
`WEBHOOK` integration, an HTTPS destination, explicit registered event types,
active/disabled state, optional description, and opaque signing-secret
reference. Create, list, update, secret rotation, and delete/deactivate routes
use centralized integration read/manage permissions. Responses expose only
`hasSigningSecret` and safe delivery/attempt metadata.

The parent `WEBHOOK` integration's `PENDING` state is a metadata container,
not a provider connection. Delivery requires an `ACTIVE` subscription and
accepts only `PENDING`/`ACTIVE` integration metadata states; other or unknown
states fail closed.
The existing event dispatcher enqueues a separate logical delivery only when
an active subscription selected that exact event type. The unique
`(event_id, subscription_id)` key keeps one delivery ID stable across attempts.
The tenant worker revalidates organization, subscription, integration,
selection, and source event; stores bounded attempt outcomes; retries transient
failures with deterministic bounded exponential jitter; and audits
dead-letter transitions. Delivery is at-least-once, not exactly-once. Receivers
must treat `X-OneCore-Delivery-ID` as an idempotency key.

Signature headers are `X-OneCore-Delivery-ID: <stable-uuid>`,
`X-OneCore-Timestamp: <unix-seconds>`, and
`X-OneCore-Signature: v1=<lowercase-hex-hmac>`. HMAC-SHA256 covers UTF-8
`<timestamp>.<delivery-id>.` plus the exact raw payload bytes. Keys must be at
least 32 bytes; payloads are at most 65,536 bytes. Verification uses a
five-minute clock window and constant-time digest comparison. Signing keys
never appear in headers or responses.

## Network and production boundary

The URL validator requires HTTPS and rejects URL credentials, queries,
fragments, non-default ports, internal names, and unsafe literal IPv4/IPv6
ranges. It does not resolve hostnames and is not complete SSRF protection.
`failClosedWebhookTransport` performs no network I/O. Production delivery
requires an explicitly reviewed transport that resolves and pins DNS results,
blocks unsafe resolved addresses, prevents rebinding, denies or revalidates
redirects, and enforces TLS, timeouts, payload and response limits. No API
handler fetches a configured URL.

See the [integration architecture](../architecture/integrations.md) and
[ADR 0014](../architecture/adr/0014-integration-secrets-and-webhook-boundaries.md)
for worker operation and remaining production requirements.

## Custom domains

`custom_domains` globally uniquifies normalized domain names, stores
verification/SSL metadata, and permits one primary domain per organization.
Authorized GET/POST/PATCH/DELETE APIs are available through
`core.organization.domains.read/manage`. New domains remain `PENDING`; only a
previously verified domain can be primary. DNS ownership verification and SSL
provisioning are not implemented.

# Integrations, secrets, and webhooks

## Integration metadata

`integrations` stores organization-scoped provider identity, a `PENDING` metadata status, and non-secret configuration under forced RLS. Authorized GET/POST/PATCH/DELETE APIs use `core.organization.integrations.read` and `core.organization.integrations.manage`, centralized authorization, verified tenant transactions, safe audit metadata, and the transactional `CONFIGURATION_CHANGED` outbox event. The API rejects secret-shaped fields and allow-lists returned configuration. Its `secret_reference` column is not accepted from clients or returned by API responses.

`PENDING` currently means only that a metadata record exists. There is no credential-configuration, connection-validation, enable/disable, or provider-health lifecycle. Do not present an integration as connected or active. No provider execution or provider-specific business behavior is implemented.

## Secret boundary

The core-domain package defines a tenant-namespaced `SecretStore` port with opaque `SecretReference` values, explicit purposes, and callback-based secret use. It is a contract only: there is no implementation, secret-manager dependency, database secret storage, or API for configuring credentials. The port must only be called by trusted server-side code after organization authorization. A production adapter must use an approved managed secret store or reviewed KMS/envelope-encryption design, enforce tenant and purpose binding, and never log or return secret bytes. Failure to resolve a secret must fail closed; there must be no plaintext database or environment-variable fallback.

Credentials and secret references must not appear in ordinary API responses, browser state, logs, audit metadata, event payloads, diagnostics, or error messages. Public integration views should expose only a boolean credential-presence indicator when a real credential lifecycle exists. Audit and configuration events record changed field names, not values or references.

## Webhook signing and delivery boundary

There is no webhook subscription table/API, signing-secret provisioning, delivery queue, retry worker, or outbound HTTP sender. The API now provides a server-side HMAC-SHA256 signing and verification primitive for future trusted delivery code; it does not itself send webhooks or resolve secrets.

The delivery adapter sends `X-OneCore-Delivery-ID: <delivery-id>`, `X-OneCore-Timestamp: <unix-seconds>`, and `X-OneCore-Signature: v1=<lowercase-hex-digest>`. The HMAC-SHA256 input is the UTF-8 bytes of `<timestamp>.<delivery-id>.` followed by the exact raw payload bytes. Signing keys must contain at least 32 random bytes, and the signer rejects payloads larger than 65,536 bytes. Verification uses the separately supplied timestamp and delivery ID, accepts timestamps within 300 seconds of the receiver's clock, and compares digests in constant time. Receivers must verify the raw request body, enforce this time window, and persist delivery IDs for idempotency. Delivery is intended to be at-least-once, not exactly-once; consumers should process each stable delivery ID at most once.

Configuration-change events already use the transactional outbox. That outbox is not an external webhook queue: webhook delivery must be a separately authorized outbox handler that performs network I/O after the business transaction commits. Until then, no external delivery occurs.

The existing HTTPS URL validation is metadata validation, not SSRF protection. Before enabling outbound delivery, implement and test a centralized egress boundary that validates DNS results and every redirect, blocks loopback/private/link-local/metadata destinations and internal names, resists DNS rebinding, enforces HTTPS, payload-size and timeout limits, and safely handles responses. Do not fetch configured endpoints directly from application routes or arbitrary handlers.

## Authorization and provider boundary

Organization identity comes from the authenticated session and active membership; route IDs do not select tenants. RLS remains enabled and forced, and the database runtime role must remain least-privileged. Existing integration mutations are audited without secret data. Do not add secret-specific permission keys or provider APIs until a concrete credential lifecycle is introduced into the existing RBAC model.

Provider adapters belong behind trusted server-side services and the secret-store port. Payment, messaging, accounting, banking, identity, storage, and customer-specific provider workflows are intentionally not implemented here. A real secret-store adapter, webhook registration/delivery persistence, and SSRF-safe outbound networking are production dependencies for enabling those capabilities.
