# ADR 0015: Communications and content services

- Status: accepted
- Date: 2026-10-08

## Context

The platform needs tenant-scoped, provider-neutral communication contracts and
reliable queueing without placing provider I/O inside business transactions.
Existing authorization, forced tenant RLS, integration metadata, opaque
`SecretStore` references, and the transactional outbox provide useful
boundaries. Production provider credentials, provider adapters, browser
communication UI, a production scheduler/monitoring service, and an
SSRF-safe production transport are not available and must not be inferred from
test adapters or interfaces.

## Decisions

- Define EMAIL, SMS, and WhatsApp provider contracts in core-domain. Keep
  `IN_APP` on the existing notification service.
- Store localized content as versioned templates. Permit draft edits, but
  make published content immutable; publishing a replacement retires the
  prior version for the same locale.
- Resolve locale from request, recipient membership, organization, then
  platform English fallback. Resolve preferences from platform default,
  organization override, then recipient/user override.
- Enqueue message, delivery, audit mutation, and `COMMUNICATION_QUEUED`
  outbox event atomically within the authorized tenant transaction. Keep
  rendered content and recipient addresses out of response/event/audit
  projections.
- Scope idempotency keys to the tenant, compare canonical content hashes, and
  reuse the delivery UUID as the stable provider idempotency key.
- Claim deliveries with leases in a database transaction, revalidate tenant,
  recipient, provider and lease state before execution, and perform provider
  I/O only after the claim transaction commits.
- Bound retry attempts and delays, dead-letter exhausted work, record safe
  failure metadata, and erase rendered subject/body at terminal delivery state.
- Resolve integration credentials through the tenant- and purpose-scoped
  `SecretStore` port. Keep provider configuration strict and allow-listed;
  require adapters to be explicitly registered for execution.
- Preserve forced RLS, composite tenant foreign keys, centralized
  authorization, mutation audit, and outbox event conventions.
- Treat the provider interface as an execution boundary, not an HTTP client.
  Do not add arbitrary endpoint configuration or claim SSRF-safe transport
  until an approved outbound transport is implemented and validated.

## Consequences and limitations

The platform can validate and persist communication intent, render content,
track attempts, and run deterministic injected providers in tests. The current
injected test providers do not perform network I/O and their call records omit
credentials, recipient addresses, and message content. There are no production
EMAIL/SMS/WhatsApp adapters or concrete SecretStore implementation. The
provided destination resolver supports EMAIL only; SMS/WhatsApp require an
injected resolver. There is no browser communication UI, production
scheduling/monitoring, or live PostgreSQL validation. Database integration
tests run on PGlite; PostgreSQL deployment-specific policy, trigger, grant,
and operational behavior still requires validation. Production enablement
therefore remains blocked on those separately provisioned capabilities.
