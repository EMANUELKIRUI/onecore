# Business application

The authenticated workspace provides a data-backed dashboard with verified
organization and branch context, registered module/entitlement status, recent
notifications, and workflow execution status. Authorized screens use existing
APIs for the signed-in user's notification preferences, recipient-scoped
communication delivery status, message-template metadata, organization
configuration, effective feature availability, role permission grants and data
scopes, and workflow execution history. Notification preferences and language
can be updated through the existing self-service preferences API.

Login/session handling, profile/session summary, password change, and sign-out
are included. Regional organization settings and legal name can be updated
through the existing settings API; effective feature values remain read-only.
The branch view lists only active branch choices returned by the authenticated
session. The member view lists only the signed-in user's own
active memberships; no tenant member directory, membership details/role
assignment UI, organization lifecycle editor, or branch management API is
available to this app. Likewise, there is no tenant-authorized audit-log read
API or active-session/device revocation API. These unavailable capabilities
are identified in the UI rather than represented with fake data or CRUD.

Module and capability navigation is filtered by successful protected API
reads as a usability feature; direct URLs and frontend checks do not grant
access. Every API remains responsible for authorization, tenant, branch, and
data-scope enforcement. Message templates display status/version metadata but
not template bodies. Communication delivery views omit message content,
recipient details, credentials, and internal payloads.

No POS, inventory, finance/accounting, HR/payroll, CRM, industry module, AI
screen, or visual workflow designer is included. Workflow UI is limited to the
Phase 18 execution history and safe action status supported by its API.

The app uses native HTML, CSS, and ES modules; no framework, bundler, or
compiled application artifact is required. Serve this directory and
`packages/ui/` from the same static origin, with that origin reverse-proxying
the used API paths to OneCore. Configure the optional `onecore-api-base` meta
tag with a same-origin path prefix only. Frontend authentication state remains
in memory and the HttpOnly cookie is managed by the API.
