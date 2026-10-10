import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const registration = await readFile(
  new URL("../register/index.html", import.meta.url),
  "utf8",
);
const registrationApplication = await readFile(
  new URL("../register/registration.js", import.meta.url),
  "utf8",
);

describe("public marketing experience", () => {
  it("provides the requested public sections and consistent sign-in entry points", () => {
    for (const id of ["products", "industries", "features", "pricing"]) {
      expect(page).toContain(`id="${id}"`);
    }
    expect(page.match(/href="\.\.\/business\/"/g)?.length).toBeGreaterThan(1);
    expect(page).toContain('aria-label="Main navigation"');
    expect(page).toContain('aria-label="Footer"');
    expect(page).toContain('href="#main-content"');
    expect(page).toContain('class="oc-hero"');
    expect(page).toContain('class="oc-platform-visual"');
    expect(page).toContain('class="oc-brand-mark"');
    expect(page.match(/href="register\/"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toMatch(/>\s*Sign in\s*</);
  });

  it("states unavailable product, pricing, and registration boundaries honestly", () => {
    expect(page).toContain("Product-specific business modules are not yet");
    expect(page).toContain("Public plan details");
    expect(page).toContain("self-service registration");
    expect(page).not.toMatch(/fake|sample data|demo metrics/i);
    expect(page).not.toMatch(/https?:\/\/(?!localhost)/i);
  });

  it("describes the reviewed organization application flow", () => {
    expect(registration).toContain('id="registration-title"');
    expect(registration).toContain(
      "Submit your organization details for review.",
    );
    expect(registration).toContain('id="registration-form"');
    expect(registration).toContain('src="./registration.js"');
    expect(registrationApplication).toContain(
      '"/public/organization-applications/modules"',
    );
    expect(registrationApplication).toContain(
      '"/public/organization-applications"',
    );
    expect(registrationApplication).toContain('method: "POST"');
    expect(registrationApplication).toContain("Your request is pending review");
    expect(registration).toContain('href="../../business/"');
    expect(registrationApplication).not.toMatch(/localStorage|sessionStorage/);
    expect(registrationApplication).not.toMatch(
      /plans?\s*:\s*\[|mock|fake api/i,
    );
  });
});
