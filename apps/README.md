# Applications

Application workspaces share UI foundations from `packages/ui` and consume
service APIs. They must not access persistence directly.

- `marketing/`: public product and company presence. The initial public landing
  page is implemented.
- `business/`: organization-facing application. The initial authenticated
  shell uses the existing session, organization, branch, logout, and password
  change endpoints.
- `superadmin/`: supports organization-application review through the
  platform lifecycle API; broader platform administration remains deferred.
- `support/`: provides an unavailable-state shell; support APIs and workflows
  are not implemented.
- `status/`: reserved for service status experience.

The pages are dependency-free native ES modules and styles. Serve each
application from a static host with a same-origin reverse-proxy path to the
existing API. The business page's `onecore-api-base` meta value may specify a
same-origin path prefix; do not put secrets in frontend configuration.
