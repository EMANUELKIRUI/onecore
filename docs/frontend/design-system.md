# Frontend foundation

## Current applications and stack

Phase 14 completes the dependency-free frontend foundation in
`apps/marketing`, `apps/business`, and `packages/ui`. Marketing provides
platform, products, industries, features, and pricing information alongside
workspace sign-in. These pages describe shared capabilities and clearly state
that business modules, public pricing, and self-service registration are not
available; they do not fetch fabricated content. There is no public
registration/onboarding API.

The business application provides login/session bootstrap, an authenticated
overview, verified organization/branch context selection, profile/session
details, password change, sign-out, notifications, workflow execution history,
and server-authorized read views for modules/entitlements, roles/permissions,
and organization settings. Each data view uses its existing API and renders
loading, empty, denied/error, and retry states. Role, module, and settings
navigation is only exposed after an API request succeeds; that UI behavior is
not an authorization decision.

Organization settings are currently a limited read-only summary. The API does
not expose an active-session list, organization user listing, platform
organization administration, or audit-log read route to this application.
Consequently the UI does not pretend to provide those screens or CRUD
operations. It does not provide a workflow designer or business-module
screens. `apps/superadmin`, `apps/support`, and `apps/status` remain reserved.

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

The business shell includes an API-backed notification inbox and workflow
activity view. It displays only the signed-in recipient's notification
content, and exposes the mark-read operation through the existing API. Workflow
history omits event payloads, notification content, recipient data, and job
internals. Modules and entitlements, roles and permission catalogs, and a
limited organization configuration summary are read from existing APIs;
settings and access catalogs are not client-side authority. The shell shows
explicit empty states until actual business modules are implemented and must
not show fabricated metrics or inactive routes. Public content is static and
does not claim live API status.

## Locale-aware presentation

`@onecore/ui` exports translation fallback and `Intl`-based formatting helpers
for dates, times, numbers, percentages, and currencies. Translation catalogs
and default text are supplied by callers; the shared package does not invent
translations or replace the existing native HTML/CSS/ES-module approach.
Locale formatting is presentation-only. Use machine-readable API values and
pass the organization's configured IANA timezone when formatting instants;
formatters default to UTC rather than the browser's implicit timezone. Never
parse localized date strings as API or database values. The server remains
authoritative for organization configuration, authorization, and persistence.

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
