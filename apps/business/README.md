# Business application

Phase 14 provides an authenticated organization workspace with login and
session handling, organization and authorized branch selection, profile/session
summary, password change, sign-out, an in-app notification inbox, and workflow
execution history. It also provides server-authorized read views for the module
catalog and organization entitlements, roles and permissions, and the
implemented organization settings summary.

These are platform foundation views, not business modules. Organization
settings are read-only in this UI. There is no user directory, active-session
list, audit-log read endpoint, or platform organization administration screen
available to this app, so no fake CRUD or audit data is shown. Module and
access navigation is filtered by successful API reads as a usability feature;
every API remains responsible for authorization.

No POS, inventory, finance/accounting, HR/payroll, CRM, industry module, AI
screen, or workflow designer is included.

The app uses native HTML, CSS, and ES modules; no framework, bundler, or
compiled application artifact is required. Serve this directory and
`packages/ui/` from the same static origin, with that origin reverse-proxying
the used API paths to OneCore. Configure the optional `onecore-api-base` meta
tag with a same-origin path prefix only. Frontend authentication state remains
in memory and the HttpOnly cookie is managed by the API.
