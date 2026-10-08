# Frontend foundation

## Current applications and stack

Phase 14 completes the dependency-free frontend foundation in
`apps/marketing`, `apps/business`, and `packages/ui`. Marketing provides
platform, products, industries, features, and pricing information alongside
workspace sign-in. These pages describe shared capabilities and clearly state
that business modules, public pricing, and self-service registration are not
available; they do not fetch fabricated content. There is no public
registration/onboarding API.

The business application provides login/session bootstrap, a data-backed
dashboard, verified organization/branch context selection, profile/session
details, password change, sign-out, and existing-API views for modules and
entitlements, roles and their permission/data-scope grants, organization
configuration, effective feature values, notifications, notification
preferences, communication template status/version metadata, recipient-scoped
delivery status, and Phase 18 workflow execution history. Notification
preferences and language use the existing self-service update endpoint.
Dashboard previews use the same protected module, inbox, and workflow APIs;
they do not invent uptime, transactions, counts, or business metrics. Each
API-driven page provides loading, empty, forbidden/error, and retry states.
Capability navigation is shown after a protected read succeeds, only as a UX
convenience; direct URLs and hidden links do not authorize requests.

The organization screen updates regional preferences and legal name through
the existing settings `PATCH` API; the API remains the authority for
validation and permission checks. Effective feature values are read-only.
Branches shown in the application come only from the authenticated session's
active authorized branch choices. The session response provides the
signed-in user's own active organization memberships, not a tenant member
directory; membership status details and role assignment UI are therefore not
claimed. No current organization-scoped API exposes organization lifecycle
editing, a branch directory/manager, active-session listing/device revocation,
or tenant audit-log reads to this application. These boundaries are explicit
and display no fabricated records. `apps/superadmin`, `apps/support`, and
`apps/status` remain reserved.

## Business Manager frontend boundary

Business Manager is a section of the existing authenticated application, not a
second shell or a new module registry entry. Its overview is composed from
verified session context, registered module/entitlement data, recent
notifications, and workflow execution history. It does not display metrics
that those APIs do not provide.

The business profile and settings views reuse the organization configuration
API. The existing `core.organization.settings.read` and
`core.organization.settings.update` permissions govern reads and mutations on
the server. The UI offers the existing legal-name, registration-number,
tax-number, country, currency, locale, and time-zone fields. Organization
status/name mutation and typed contact/address editing are not exposed by the
current contract. Arbitrary address/tax JSON is not rendered.

Customers and Products & Services use the tenant-authorized Business Manager
APIs for customer and catalog-item search, pagination, detail, create, update,
and deactivate. The API and database enforce the registered module
entitlement, canonical permissions, active organization/branch context, data
scopes, transactional audit/outbox mutations, and forced tenant RLS.
Organization and branch changes clear the visible resource state before
reloading it. Branch listing and switching reuse the session's authorized
branch choices and `/auth/branch`. Workflow activity uses the existing
tenant-authorized execution-history API; the audit log has no corresponding
tenant read API.

See [Business Manager capability map](../modules/business-manager.md) for the
resource fields, schema, API, permission, lifecycle, and security boundaries.

The shared `@onecore/ui` workspace uses native HTML, CSS, and browser ES
modules. There is no framework, router, component runtime, or client state
dependency to duplicate. Static applications should be hosted behind a
same-origin reverse proxy to the OneCore API. The business app uses a
same-origin path prefix configured in its `onecore-api-base` meta element;
frontend configuration must never contain credentials.

## Tokens and components

`packages/ui/styles.css` owns the core surface, foreground, muted, primary,
status, border, radius, spacing, shadow, layout-width, z-index, and motion
tokens. Organization primary-color branding can be applied through
`applyBranding`; it accepts only 3- or 6-digit hexadecimal colors. Light and
dark tokens are centralized, with system theme as the default. The UI package
provides reusable layout and responsive shell classes, form controls, buttons,
status/alert/empty/loading patterns, table styles, native dialog support, and
live-region toast announcements.

Use semantic HTML controls and shared variants instead of page-specific
controls. The shared classes cover buttons, fields/selects, forms, cards,
responsive tables, status badges, tabs, native disclosure/dropdown patterns,
pagination, alerts, toasts, and loading/empty/error states. Shared helpers
provide live announcements, busy state, associated field errors, safe status
badges, theme changes, and native dialogs. Inputs must have labels and
descriptions; validation and server errors must be connected to accessible
status/alert regions. Native `dialog` provides keyboard and focus behavior for
confirmations, with `showDialog` exposing the shared entry point. Respect
reduced-motion preferences and keep visible keyboard focus.

## Application shell and capabilities

The organization shell obtains the user, organization memberships, branch
choices, and active context from `GET /auth/session`. It delegates organization
and branch selection, logout, and credential change to the existing API
endpoints. Session cookies remain HttpOnly; the UI does not place credentials
or authentication state in local or session storage. Expired sessions return
to sign-in, while 401/403/404 and transport failures receive safe user-facing
messages rather than raw backend details.

Navigation can be filtered with `filterNavigation` only when a future API
contract supplies server-resolved permissions and entitled modules. The
current session response does not expose those capability lists, so the shell
does not pretend to show or enforce them. A hidden action is usability only;
the API and database remain the authorization boundary.

The notification inbox displays only the signed-in recipient's notifications
and exposes the existing mark-read operation. User preferences are
self-service; organization notification defaults remain outside this UI.
Communication history is limited to deliveries addressed to the signed-in
user and does not render message bodies, recipient details, provider
credentials, or payloads. Templates are presented as status/version metadata;
template bodies are not rendered. Workflow history omits triggering payloads,
resource identifiers, notification content, recipient data, and job
internals; the UI does not provide workflow authoring or scheduling. Role
details show server-returned permission keys and scope types. None of these
views replaces server-side authorization or tenant/branch/data-scope checks.
The shell clearly identifies registered modules whose business UI is not
implemented and does not present them as operational.

## Locale-aware presentation

`@onecore/ui` exports translation fallback and `Intl`-based formatting helpers
for dates, times, numbers, percentages, and currencies. Translation catalogs
and default text are supplied by callers; the shared package does not invent
translations or replace the existing native HTML/CSS/ES-module approach. The
business app uses the existing supported locale resolution and formatting
helpers for user and regional presentation; this does not claim a fully
translated application. Locale formatting is presentation-only. Use
machine-readable API values and pass the organization's configured IANA
timezone when formatting instants; formatters default to UTC rather than the
browser's implicit timezone. Never parse localized date strings as API or
database values. The server remains authoritative for organization
configuration, authorization, and persistence.

## Deployment and branding

Serve the application and shared styles from the same origin and route API
requests through a same-origin reverse proxy. No production hostname is
embedded in reusable assets. Static assets are source files, not a security
boundary; deployment must apply an appropriate content-security policy and
HTTPS configuration.

Organization branding is a presentation input to shared tokens, not a
customer-specific code path. Until a backend branding contract is connected,
the default OneCore palette is used. Authentication, organization access,
branch assignment, roles, permissions, modules, and feature flags continue to
be resolved by trusted server services.
