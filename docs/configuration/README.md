# Organization configuration

Configuration is preferred to customer-specific source changes. Organization differences should be expressed as relational settings, subscription/module entitlements, feature flags, workflow definitions, and—only when necessary—compatible OneCore extensions or a reviewed reusable platform change. Separate customer code branches are prohibited.

## Structured configuration

Important domain concepts are relational:

- `organization_settings`: country, currency, timezone, locale, address, and tax information;
- `business_settings`: legal identity and payment-method identifiers;
- `organization_branding`: logo/favicon references, colors, invoice/receipt templates, email branding, and SMS sender;
- `numbering_configurations`, `tax_configurations`, `notification_configurations`, and `organization_storage`: focused records with explicit ownership;
- `organization_configurations`: versioned, keyed JSONB for genuinely dynamic, non-secret platform/module settings.

JSONB does not replace columns, foreign keys, uniqueness, or validation for core concepts. Dynamic JSON must have a versioned schema and validation at its trusted service boundary. Integration credentials must never be placed in configuration JSON or ordinary organization rows; use an encrypted secret store and persist only a secret reference.

Supported initial locales are English (`en`) and Kiswahili (`sw`); use locale identifiers so future French, Arabic, Amharic, Portuguese, Kinyarwanda, Somali, and Luganda can be added without schema changes. Store country as ISO alpha-2, currency as ISO 4217, and timezone as an IANA identifier.

## Money and historical facts

Store exact amounts in PostgreSQL `numeric`, alongside currency codes. A future business transaction must retain its original amount/currency and the exchange-rate value, source, and effective time used at that transaction; never rewrite historic amounts using a current rate. This phase adds no operational financial transactions.

## Custom fields

`custom_field_definitions` are unique per organization/entity/key and declare one of `TEXT`, `NUMBER`, `BOOLEAN`, `DATE`, `DATETIME`, `CURRENCY`, `SELECT`, `MULTI_SELECT`, or `REFERENCE`. `custom_field_values` are separately tenant-scoped and reference a definition through a composite organization/definition foreign key. The domain package supplies a type-specific value parser. Dynamic resource references are not foreign keys to arbitrary module tables; the owning service must validate resource existence and field options.

Custom field names/options/validation are untrusted configuration, not executable code. Limit and validate option shape, field values, reference access, and sensitive data use in the future service layer.

## Feature flags

Definitions (`feature_flags`) are distinct from scoped assignments. The central `evaluateFeatureFlag` abstraction resolves `USER` → `ORGANIZATION` → `MODULE` → `ENVIRONMENT` → `GLOBAL` → definition default. Assignment dimensions have database checks and uniqueness constraints. Evaluation is server-side; never treat a client-visible flag as permission or module entitlement. All flag mutations must be recorded in audit history by the service that changes them.

## Deployment model

Deployment type is organization data for future provisioning/billing/support policy; it must not become a collection of scattered code branches. See the [deployment model](../deployment/README.md).
