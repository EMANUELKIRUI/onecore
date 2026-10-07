# Integrations, Secrets, and Webhook Delivery

## Existing integration metadata

`integrations` remains the organization-owned provider metadata record. The
existing CRUD APIs use `core.organization.integrations.read/manage`, verified
organization transactions, forced RLS, allow-listed configuration, safe audit
metadata, and the transactional `CONFIGURATION_CHANGED` event. Its opaque
`secret_reference` is never accepted from clients or returned. `PENDING` is
metadata-only and does not represent a validated connection or active provider.

## Secret lifecycle and adapter boundary

`SecretStore` is the server-side typed contract for storing, rotating,
callback-only secret use, deletion, and metadata lookup. Every call includes
an organization and purpose; references are opaque. Credential endpoints
accept values only for create/rotation and return configured/version metadata,
never values or references. Existing integration permissions authorize these
operations; no parallel permission system exists.

The runtime's default `unavailableSecretStore` throws a fixed unavailable
error. There is no plaintext, environment-variable, or database fallback. A
production adapter must bind tenant and purpose in its own authorization,
provide idempotent operations, protect key material, and define orphan-version
cleanup. Secret storage and PostgreSQL cannot commit atomically: mutations
store a new version before writing its opaque reference, audit, and outbox event
in one tenant transaction, then best-effort remove the previous version.
Deployments must inject an approved secret manager/KMS implementation before
credential APIs can succeed.

## Subscription and event selection

Webhook subscriptions reference a same-organization `WEBHOOK` integration,
HTTPS destination, explicit registered event types, active/disabled state,
description, and opaque signing-secret reference. Creating a subscription
requires a signing secret. Public routes expose only `hasSigningSecret`.
Subscription mutations use the existing integration read/manage permissions,
tenant context, forced RLS, safe audit records, and configuration outbox
events.

The parent `WEBHOOK` integration's existing `PENDING` state is a metadata
container, not a provider connection. Delivery requires an `ACTIVE` subscription
and accepts only the existing `PENDING`/`ACTIVE` metadata states; disabled,
revoked, error, and unknown states fail closed.

The existing authorized event dispatcher runs webhook enqueue handlers in the
event transaction. A handler selects only active subscriptions for that
organization whose explicit event-type list contains the event, and inserts
one logical delivery per `(event_id, subscription_id)`. The delivery ID is
generated once and reused for every attempt. The internal `outbox_events`,
`event_processing_records`, and `event_dead_letters` remain the business-event
system; external HTTP delivery uses separate webhook delivery and attempt
tables.

## Delivery, retries, and idempotency

`createWebhookDeliveryWorker` claims a bounded tenant batch under transaction
local organization context and forced RLS, with row locks and expiring leases.
Before attempt it rechecks active organization, subscription, provider kind,
event selection, secret reference, and source event. Attempt records hold
status, HTTP status, fixed failure codes, timestamps, and allow-listed bounded
response metadata only. Request bodies, response bodies, authorization
headers, cookies, and secrets are not stored.

HTTP 408, 429, and 5xx plus network/timeout/backend failures are retryable.
Other non-2xx responses are permanent. The maximum is eight attempts by
default; exponential delay is capped at one hour and uses deterministic
delivery-ID/attempt-derived jitter. Exhaustion transitions to
`DEAD_LETTERED` and writes an audit record. This is at-least-once delivery,
not exactly-once: receiving systems must persist `X-OneCore-Delivery-ID` as
their idempotency key before applying an event.

## Signature contract

The sender contract uses these headers:

- `X-OneCore-Delivery-ID: <stable-uuid>`
- `X-OneCore-Timestamp: <unix-seconds>`
- `X-OneCore-Signature: v1=<lowercase-hex-hmac>`

The HMAC-SHA256 input is UTF-8 `<timestamp>.<delivery-id>.` concatenated with
the exact raw payload bytes. Signing secrets must contain at least 32 bytes;
payloads are limited to 65,536 bytes. Receivers compare the digest in constant
time, reject timestamps more than 300 seconds from their clock, verify the raw
body, and deduplicate delivery IDs. No signing material is sent in headers.

## Outbound network boundary

`validateWebhookEndpoint` requires HTTPS, rejects URL credentials, query and
fragment components, non-default ports, internal names, and known unsafe
literal IPv4/IPv6 ranges (including loopback, private, link-local, multicast,
unspecified, mapped, and metadata ranges). This is defense-in-depth URL
validation, not DNS-aware SSRF protection.

`OutboundWebhookTransport` is a typed injection boundary. The default
`failClosedWebhookTransport` performs no network operation. No API handler
fetches a configured endpoint. Production delivery remains disabled until an
approved transport resolves and pins public addresses at connection time,
blocks every prohibited resolved address, prevents DNS rebinding, disables or
revalidates redirects, enforces TLS, timeout and payload limits, and bounds
response handling. A transport must not become production-capable merely by
setting a type flag; deployment review and network tests are required.

The worker factory currently requires a trusted caller to supply each
organization ID; a scheduler, lease monitoring, operational delivery metrics,
dead-letter recovery UI/API, and live PostgreSQL role validation remain
deployment work. Do not run it with the default egress and secret adapters
expecting delivery to succeed.

## Intentionally out of scope

No provider-specific integration, payment or messaging workflow, webhook test
send route, integration UI, cloud secret-manager implementation, or live
outbound HTTP client is included. See [ADR 0014](adr/0014-integration-secrets-and-webhook-boundaries.md)
for the boundary decision and [event architecture](events.md) for internal
outbox guarantees.
