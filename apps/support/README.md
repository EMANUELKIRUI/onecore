# Support application

The Support client uses the same-origin `/api` proxy and the API's host-only
session cookie. Its configured API base is injected at build time through
`ONECORE_API_BASE_PATH`; an empty base deliberately leaves the unavailable
state visible. The Vercel project must set `ONECORE_MARKETING_URL` for shared
navigation.

The API enforces customer organization membership and forced row-level security.
Support staff require the `SUPPORT` platform role, authenticator-app MFA, an
active, unexpired organization grant, and assignment to an individual request.
Root administration is a separate provisioned marker; the `SUPERADMIN` role or
an email address alone does not imply Root access. A Root administrator must
use the secure Superadmin bootstrap command after the support migration is
installed to confirm the initial Root marker. An existing support staff account
can then be enabled and granted time-limited organization access through the
Root-only API operations.

The API routes are:

- `GET /support/requests?page=&limit=`
- `POST /support/requests`
- `GET /support/requests/:requestId`
- `PATCH /support/requests/:requestId`
- `POST /support/requests/:requestId/messages`
- `POST /support/requests/:requestId/notes`
- `POST /platform/support/requests/:requestId/assignment`
- `POST /platform/support/staff`
- `DELETE /platform/support/staff/:userId`
- `POST /platform/support/organizations/:organizationId/grants`
- `DELETE /platform/support/grants/:grantId`

Only customer-visible messages are returned to organization members. Internal
notes require assignment and an active support grant. Organization access
grants are audited, expire within at most 30 days, and are revoked immediately
when support staff are disabled.

The application displays real API responses only. It does not include
credentials, support tokens, or sample customer records.
