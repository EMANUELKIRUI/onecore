# Communications and Content Services

## Scope

Phase 17 provides tenant-scoped communication contracts, persistence, API
operations, transactional queueing, and an injectable delivery worker. The
provider-neutral external channels are EMAIL, SMS, and WhatsApp. `IN_APP`
continues to use the existing notification service and is not an external
provider delivery.

## Contracts and templates

Core-domain schemas define provider inputs/results, delivery states, queue
requests, templates, and scalar template variables. Template expressions are
limited to declared variables; values are rendered as inert text. Sensitive
variable names and secret-like metadata are rejected, and input sizes are
bounded.

A template has a stable organization-scoped key and channel. Content is stored
in numbered, locale-specific versions. Draft versions may be edited; published
content cannot be changed or deleted. Publishing a new version retires the
previous published version for that locale. Retired versions remain immutable.

## Locale and preferences

The requested locale is taken from the enqueue request, then the recipient's
organization membership, then the organization locale. Template selection
tries the requested BCP 47 locale, its language, the organization locale and
its language, and finally platform English (`en`), removing duplicates.

Preference resolution is ordered as platform default, organization override,
then recipient/user override; the most specific defined value wins. The current
platform default enables `IN_APP` and disables EMAIL, SMS, and WhatsApp unless
an organization or user preference opts in. User preference APIs address only
the authenticated user's own membership.

## Enqueue and delivery

An authorized enqueue resolves an active tenant member, preferences, locale,
published template version, and enabled provider metadata, then renders the
content. In one organization-scoped database transaction it writes the message,
delivery, mutation audit record, and `COMMUNICATION_QUEUED` outbox event. The
event contains identifiers and non-content metadata, not rendered text,
recipient address, or credentials. Enqueue responses expose IDs, chosen
version/locale, outcome, and current delivery status only.

An optional tenant-scoped idempotency key is unique per organization. The
canonical request content is SHA-256 hashed. A repeated key with the same hash
returns the existing message/delivery IDs and the delivery's actual current
state; a different hash returns an idempotency conflict. The stable delivery ID
is also supplied as the provider idempotency key across attempts.

The worker claims due deliveries with row locks and expiring leases in a
separate transaction. Before sending, it verifies the lease and re-reads the
message, tenant status, active recipient membership/user, provider config and
integration state, credential reference, and provider configuration through
the registered provider. It resolves the destination and obtains the
credential through `SecretStore`. The provider call occurs only after claim
transaction completion, never inside the enqueue/claim transaction. A final
lease check gates persistence of the attempt result.

Enqueue currently sets a five-attempt ceiling. Retry delay is bounded, and
rate-limit retry hints are capped by the worker's configured maximum. Retryable
failures return to `RETRYING`; exhausted retries become `DEAD_LETTER`, while
permanent failures become `FAILED`. Terminal outcomes clear both rendered
subject and body from the message row. Content SHA-256, delivery/attempt state,
provider message ID, timestamps, and safe failure codes remain for history.
Delivery-history and attempt APIs do not select or return rendered content.

## Secrets, providers, and outbound transport

Credentials are represented by opaque integration secret references. Worker
access uses the tenant- and purpose-scoped `SecretStore` port; credentials are
not included in provider configuration JSON, API responses, audits, events, or
test-adapter call records. No concrete production SecretStore is included.

The provider configuration API accepts only `senderName`, `senderAddress`,
`replyTo`, `region`, `environment`, and `accountReference`; it rejects
additional properties. Provider keys are syntax-validated in metadata and
must also match a channel-specific provider registered by the process before
an adapter can execute. The worker validates the stored configuration against
that adapter.

There are no production EMAIL, SMS, or WhatsApp adapters. The provider
interface is an injection boundary, not an HTTP transport. Communication
configuration cannot supply an arbitrary URL, and no communications-specific
SSRF-safe transport is implemented. Any future network adapter must use an
approved outbound boundary that enforces DNS/address checks, redirect policy,
TLS, timeouts, and response limits. The default worker resolver supports EMAIL
only; SMS and WhatsApp need an explicitly injected destination resolver.

## Tenant isolation, authorization, and audit

Communication provider configs, templates/versions, preferences, messages,
deliveries, and attempts have forced tenant RLS. Tenant-scoped composite
foreign keys protect cross-organization relationships. Database operations
run with an organization context; missing context exposes no tenant rows.

API routes require an authenticated organization context and the applicable
notification, inbox-self, or integration permissions. Organization defaults
and templates require management permission. Recipient preference reads and
updates are self-scoped. Anonymous operations are rejected, and organization
path IDs must match the authenticated tenant.

Template/provider/preference configuration mutations write authorization audit
records and configuration-change events where applicable. Enqueue writes an
audit record and a transactional outbox event. Failed and dead-lettered
attempts write audit records with safe failure metadata. Successful delivery
currently updates state but does not emit a separate delivery-success event.
No address, rendered text, or credential is intended for audit/event payloads.

## Current limitations

- Provider adapters are deterministic test implementations only; they make no
  network calls and record only channel, delivery ID, idempotency key, and
  recipient user ID.
- There is no production SecretStore, communications UI in a browser, or
  production scheduler/monitoring and operational alerting. `scheduledAt` is
  persisted and respected by the worker's due-time query, but no scheduler is
  provided here.
- SMS/WhatsApp destination resolution requires an injected implementation;
  the default resolver only supports email.
- No production SSRF-safe communications transport or live PostgreSQL
  validation is included. Database integration tests use PGlite and do not
  substitute for validating policies, triggers, and grants against the
  production PostgreSQL version/configuration.
- `IN_APP` notifications remain on the existing notification service; the
  communications delivery queue is for EMAIL, SMS, and WhatsApp only.
