# Marketing application

Phase 14 completes the static public experience with platform, products,
industries, features, and pricing sections, consistent navigation/footer, and
links to the authenticated workspace. The content describes only implemented
platform foundations. It explicitly states that specialized business
products and public pricing are not yet available. The registration page
submits an organization application for administrator review, but does not
create an owner login or provision workspace access. The site does not
fabricate backend data or product functionality.

The marketing landing page is static. The separate registration page loads the
public module catalog and submits applications through the API, with explicit
empty and error handling. The pages use shared `packages/ui` styles, semantic
landmarks, a skip link, and responsive navigation without hard-coded
deployment domains.
