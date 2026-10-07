# Business application

The initial organization-facing shell provides login, session bootstrap,
organization and authorized branch selection, account security/password
change, and logout using the existing API contracts. It intentionally contains
no business metrics or module routes because those resources are not yet
implemented.

The app uses native HTML, CSS, and ES modules; no framework or bundler is
required. Serve this directory and `packages/ui/` from the same static origin,
with that origin reverse-proxying `/auth/*` to the OneCore API. Configure the
optional `onecore-api-base` meta tag with a same-origin path prefix only.
Frontend authentication state remains in memory and the HttpOnly cookie is
managed by the API.
