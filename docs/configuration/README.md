# Configuration and customization

OneCore customization is shared platform behavior, not customer-specific code. Prefer this order: configuration, a feature flag, a reusable workflow, a compatible extension, and only then reviewed custom development. Never create organization-specific source forks.

## Precedence and trust

The intended hierarchy is system defaults, platform configuration, module defaults, organization configuration, branch configuration, and explicitly supported personal preferences. Feature resolution applies user, branch, organization, module, environment, platform/global, then system/default precedence. Personal configuration is not persisted. Security controls are never organization-overridable.

The API derives organization identity from the authenticated session and active membership. Organization IDs in route paths are checked against that context; they are never authority by themselves. Configuration reads and writes run through centralized RBAC authorization and the tenant transaction. RLS remains the database boundary. Platform roles do not override it.

## Structured configuration

Important domain concepts are relational:

- `organization_settings`: country, currency, timezone, locale, address, and tax information;
- `business_settings`: legal identity and payment-method identifiers;
- `organization_branding`: logo/favicon references, colors, invoice/receipt templates, email branding, and SMS sender;
- `numbering_configurations`, `tax_configurations`, `notification_configurations`, and `organization_storage`: focused records with explicit ownership;
- `organization_configurations`: versioned, keyed JSONB for genuinely dynamic, non-secret platform/module settings.

JSONB does not replace columns, foreign keys, uniqueness, or validation for core concepts. Dynamic JSON must have a versioned schema and validation at its trusted service boundary. Integration credentials must never be placed in configuration JSON or ordinary organization rows; use an encrypted secret store and persist only a secret reference.

Supported initial locales are English (`en`) and Kiswahili (`sw`); use locale identifiers so future French, Arabic, Amharic, Portuguese, Kinyarwanda, Somali, and Luganda can be added without schema changes. Store country as ISO alpha-2, currency as ISO 4217, and timezone as an IANA identifier.

## Localization and regional settings

The existing organization settings remain the source of truth for country
(`countryCode`), currency (`currencyCode`), timezone (`timezone`), and locale.
The API validates these fields through the shared core-domain regionalization
schemas; locale tags are canonicalized as BCP 47 identifiers and currently
accept the documented English and Kiswahili language set, including regional
tags such as `en-KE`. Currency codes are checked against the runtime's
`Intl` currency data. Country codes are shape-validated as uppercase alpha-2;
this does not imply a country-specific policy or a complete country registry.

The shared UI exposes `Intl`-based date, time, number, percentage, and currency
formatters. Formatters accept a valid presentation locale and an explicit
business timezone where relevant; timestamps are treated as instants, with
UTC used when a caller omits a timezone. Do not pass calendar-date strings or
localized date strings to instant formatters. Keep date-only values as
machine-readable calendar dates and do not convert them into instants without
a domain-defined timezone rule.

Translation lookup is a presentation-only abstraction: callers provide
translation catalogs and explicit default text; lookup tries the requested
locale, its language, the configured fallback locale, and its language before
using that default text. This foundation adds no translated product catalog
and does not persist a personal locale preference. API values remain
machine-readable, and the browser is never authoritative for authorization.
Country-specific tax, legal, payroll, accounting, statutory calendars, and
other business rules belong to the relevant later domain/module, not these
shared utilities.

## Money and historical facts

Store exact amounts in PostgreSQL `numeric`, alongside currency codes. A future business transaction must retain its original amount/currency and the exchange-rate value, source, and effective time used at that transaction; never rewrite historic amounts using a current rate. This phase adds no operational financial transactions.

## Custom fields

`custom_field_definitions` are unique per organization/entity/key and declare one of `TEXT`, `NUMBER`, `BOOLEAN`, `DATE`, `DATETIME`, `CURRENCY`, `SELECT`, `MULTI_SELECT`, or `REFERENCE`. `custom_field_values` are separately tenant-scoped and reference a definition through a composite organization/definition foreign key. The domain package supplies a type-specific value parser. Dynamic resource references are not foreign keys to arbitrary module tables; the owning service must validate resource existence and field options.

Custom field names/options/validation are untrusted configuration, not executable code. Tenant-authorized GET/POST/PATCH/DELETE APIs manage definitions, defaults, visibility, ordering, and status. Values remain stored by future business modules through the existing `custom_field_values` relation; this phase does not implement those business records. Server validation uses `parseCustomFieldValue`, allow-listed option/validation shapes, composite tenant foreign keys, centralized authorization, forced RLS, and audit records. No schema is created dynamically.

## Feature flags

Definitions (`feature_flags`) are distinct from scoped assignments and support `BOOLEAN`, `STRING`, `NUMBER`, and `JSON` values. Assignments support `SYSTEM`, `PLATFORM`, `GLOBAL`, `ENVIRONMENT`, `MODULE`, `ORGANIZATION`, `BRANCH`, and `USER`. `resolveFeatureFlag` validates declared values and requires authenticated, active tenant context; module resolution also requires server-loaded entitlement. Organization/verified-branch API mutations use feature-specific RBAC and audit; security-sensitive definitions cannot be changed by an organization. A flag never grants permission or module entitlement.

## Workflow and other metadata

Tenant-authorized APIs manage workflow definitions, draft versions, steps, triggers, bounded condition metadata, transitions, and allow-listed `NOTIFICATION`/`APPROVAL` action metadata. Versions are immutable after publication; activation retires the previous published version, and deactivation retires the active version. One published version per workflow is enforced in PostgreSQL. Metadata is never executed as SQL, shell commands, JavaScript, or application code. There is no visual builder or workflow execution engine.

Organization notification preference GET/PATCH APIs validate event, channel, enabled state, recipient mode, and optional session-verified branch scope. Integration GET/POST/PATCH/DELETE APIs allow-list non-secret provider metadata, reject secret-shaped request fields, and redact legacy unknown JSON keys and secret references from responses. No external messaging/provider execution or secret manager is implemented. Custom-domain GET/POST/PATCH/DELETE APIs normalize and globally uniquify domains; new domains remain `PENDING`, and only verified domains can be marked primary. DNS and SSL automation are not implemented.

Configuration APIs use existing organization settings permissions and dedicated feature, custom-field, workflow, notification, integration, and domain read/manage permissions. Migrations provision these permissions for existing system Organization Owner and Organization Admin roles; Manager, Staff, and Viewer do not gain management privileges. All route operations use Phase 5 centralized authorization and tenant transactions.

## Deployment model

Deployment type is organization data for future provisioning/billing/support policy; it must not become a collection of scattered code branches. See the [deployment model](../deployment/README.md).

The server-side capability resolver currently exposes the same metadata-only capabilities for `SAAS`, `CUSTOM`, `DEDICATED`, and `ENTERPRISE`. Provider execution and workflow execution remain disabled for every deployment type.

See the focused notes on [feature flags](feature-flags.md), [custom fields](custom-fields.md), [workflows](workflows.md), [notifications](notifications.md), and [integrations](integrations.md), plus [configuration security](../security/configuration-security.md).
