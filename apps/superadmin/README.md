# Superadmin application

The static application supports reviewing and transitioning organization
applications through the authenticated platform lifecycle API. Approval records
review status only; organization activation and bootstrap-owner provisioning
remain separate operations. All platform actions are authorized by the API;
the frontend does not create identities or store credentials.

The initial root Superadmin is provisioned separately through the interactive
`npm run bootstrap:superadmin -w @onecore/api` operator command for the fixed
`emanuelkirui1@gmail.com` identity. Superadmin sign-in requires server-enforced
TOTP MFA enrollment. General platform-account management and subordinate
Superadmin invitations are not implemented.
