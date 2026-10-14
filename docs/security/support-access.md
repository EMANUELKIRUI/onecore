# Support access boundary

Support is a platform service, separate from organization RBAC. Its API
permission names are defined in `services/api/src/support.ts`; all decisions
are enforced server-side and backed by forced PostgreSQL RLS.

| Permission                            | Effective authorization                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `organization.support.request.create` | Current authenticated session has an active organization membership; RLS also requires the same user and organization on insert.                                               |
| `platform.support.request.list`       | Support role with MFA; RLS limits results to requests assigned to that user and an active organization grant. Organization members only see their own organization's requests. |
| `platform.support.request.read`       | Support role, current MFA, assignment, and active grant; Root administrators can inspect the minimal request record needed to assign it.                                       |
| `platform.support.request.assign`     | MFA-verified Root administrator; target must have the Support role and a current grant for the request's organization.                                                         |
| `platform.support.request.update`     | MFA-verified Support user, assigned to the request, with a current grant.                                                                                                      |
| `support.request.reply`               | Active organization member for customer-visible replies, or assigned Support staff with an active grant.                                                                       |
| `platform.support.request.note`       | MFA-verified Support user assigned to the request with an active grant. Internal notes are excluded from customer reads by RLS.                                                |
| `platform.support.organization.grant` | MFA-verified Root administrator; access is explicitly scoped to one organization and expires within 30 days.                                                                   |
| `platform.support.staff.manage`       | MFA-verified Root administrator; may grant/revoke the Support platform role on an existing identity.                                                                           |

The `SUPPORT` platform role alone is not a data grant. Staff visibility requires
both an unrevoked, unexpired organization grant and assignment to each request.
Revoking a grant immediately denies access; disabling Support staff revokes
their grants and unassigns their open requests. Sensitive request views, queue
reads, replies, notes, assignments, and grant changes are audited in the same
transaction as the corresponding operation.

Root status is a separate database marker. It is never inferred from email or
from the `SUPERADMIN` role. The secure `bootstrap:superadmin` command creates
the initial Root marker on first provisioning; when confirming a previously
provisioned initial Superadmin it can add that marker without changing account
credentials. Run it only after the support migration is installed, with the
approved migrator connection and an interactive terminal. This operator
bootstrap has not been run against production as part of this implementation.

Support role membership attaches to an existing OneCore identity; the API does
not create identities, issue staff invitations, or grant organization
membership. Support staff must complete TOTP MFA because the API treats the
`SUPPORT` role as an MFA-required platform role. Request listings are
paginated, mutations are rate-limited, and no API accepts an organization ID
from a customer request body.

## Deployment prerequisites

The Vercel project must deploy `apps/support`, build with
`ONECORE_API_BASE_PATH=/api`, and rewrite `/api/:path*` to the API service.
Provide the public `ONECORE_MARKETING_URL` used by app navigation. Add the exact
Support HTTPS origin to the Render API's `AUTH_ALLOWED_ORIGINS`; do not use a
wildcard. These are checked-in deployment instructions, not evidence that the
current Vercel or Render environment is configured.
