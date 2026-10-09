import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const registration = await readFile(
  new URL("../register/index.html", import.meta.url),
  "utf8",
);
const registrationScript = await readFile(
  new URL("../register/registration.js", import.meta.url),
  "utf8",
);
const applicationResponse = await readFile(
  new URL("../register/application-response.js", import.meta.url),
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
    expect(page).toContain("self-service account provisioning");
    expect(page).not.toMatch(/fake|sample data|demo metrics/i);
    expect(page).not.toMatch(/https?:\/\/(?!localhost)/i);
  });

  it("submits organization applications without creating an owner account", () => {
    const normalizedRegistration = registration.replace(/\s+/g, " ");
    expect(normalizedRegistration).toContain('id="registration-title"');
    expect(normalizedRegistration).toContain(
      "Submit your organization details for review.",
    );
    expect(normalizedRegistration).toContain(
      "does not create an owner login or activate Business OS access.",
    );
    expect(registrationScript).toContain(
      'api.request("/public/organization-applications", {',
    );
    expect(registrationScript).toContain('method: "POST"');
    expect(registrationScript).toContain("parseApplicationResponse(response)");
    expect(applicationResponse).toContain('"INVALID_RESPONSE"');
    expect(applicationResponse).toContain(
      "applicationStatuses.has(application.status)",
    );
    expect(applicationResponse).toContain("application.submittedAt");
    expect(registrationScript).toContain(
      "Your request is ${application.status",
    );
    expect(normalizedRegistration).toContain('href="../../business/"');
    expect(normalizedRegistration).not.toMatch(
      /plans?\s*:\s*\[|mock|fake api/i,
    );
  });
});
