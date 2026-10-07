# Frontend foundation

## Current applications and stack

`apps/marketing` contains the initial public landing page and `apps/business`
contains the initial authenticated organization workspace. `apps/superadmin`,
`apps/support`, and `apps/status` remain reserved; no platform role or
administration capabilities are inferred by the UI.

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
controls. Inputs must have labels and descriptions; validation and server
errors must be connected to accessible status/alert regions. Native `dialog`
provides keyboard and focus behavior for confirmations, with `showDialog`
exposing the shared entry point. Respect reduced-motion preferences and keep
visible keyboard focus.

## Application shell and capabilities

The organization shell obtains the user, organization memberships, branch
choices, and active context from `GET /auth/session`. It delegates organization
and branch selection, logout, and credential change to the existing API
endpoints. Session cookies remain HttpOnly; the UI does not place credentials
or authentication state in local or session storage.

Navigation can be filtered with `filterNavigation` only when a future API
contract supplies server-resolved permissions and entitled modules. The
current session response does not expose those capability lists, so the shell
does not pretend to show or enforce them. A hidden action is usability only;
the API and database remain the authorization boundary.

The current shell links only to its overview and account-security views. It
shows an explicit empty state until actual business modules are enabled and
implemented; it must not show fabricated metrics or inactive routes. Public
content is limited to the existing platform story and links to the workspace.

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
