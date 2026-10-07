# Applications

Application workspaces share UI foundations from `packages/ui` and consume
service APIs. They must not access persistence directly.

- `marketing/`: public product and company presence. The initial public landing
  page is implemented.
- `business/`: organization-facing application. The initial authenticated
  shell uses the existing session, organization, branch, logout, and password
  change endpoints.
- `superadmin/`: reserved for platform administration; no frontend is
  implemented because the platform administration UI/API capability set is
  not yet established.
- `support/`: reserved for support workflows.
- `status/`: reserved for service status experience.

The pages are dependency-free native ES modules and styles. Serve each
application from a static host with a same-origin reverse-proxy path to the
existing API. The business page's `onecore-api-base` meta value may specify a
same-origin path prefix; do not put secrets in frontend configuration.
