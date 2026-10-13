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

## Homepage image uploads

Place supplied Marketing images in `apps/marketing/assets/images/`:

- `apps/marketing/assets/images/hero-business-owner.webp.png` (PNG, 537 × 281)
- `apps/marketing/assets/images/business-dashboard.png` (PNG, 397 × 157)

The homepage references them with relative URLs from `apps/marketing/index.html`
(`./assets/images/...`). Actual image files must be supplied before they can
appear; until then, the page shows neutral aspect-ratio placeholders and does
not fetch substitute imagery. The current uploads use PNG data and the exact
filenames shown above; they have not been renamed. The static build recursively
copies the `apps/marketing/assets/` directory into
`apps/marketing/dist/assets/`, preserving the `images/` subdirectory.
