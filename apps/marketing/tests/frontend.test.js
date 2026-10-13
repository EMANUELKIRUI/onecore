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
const homepageScript = await readFile(
  new URL("../homepage.js", import.meta.url),
  "utf8",
);
const homepageStyles = await readFile(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

describe("public marketing experience", () => {
  it("provides the responsive reference sections and removes Sign In from the header", () => {
    for (const id of [
      "main-content",
      "products",
      "industries",
      "features",
      "pricing",
    ]) {
      expect(page).toContain(`id="${id}"`);
    }
    const header = page.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).not.toMatch(/sign\s*in/i);
    for (const label of [
      "Home",
      "Features",
      "Industries",
      "Pricing",
      "Resources",
      "Get Started",
    ]) {
      expect(header).toContain(`>${label}<`);
    }
    expect(page).toContain('aria-label="Main navigation"');
    expect(page).toContain('aria-label="Footer"');
    expect(page).toContain('href="#main-content"');
    expect(page).toContain('id="marketing-menu-toggle"');
    expect(page).toContain('aria-controls="marketing-nav"');
    expect(page).toContain('aria-expanded="false"');
    expect(page).toContain('class="oc-brand-mark"');
    expect(page).toContain("ALL YOUR BUSINESS. ONE PLATFORM.");
    expect(page).toContain("Simple. Powerful.");
    expect(page).toContain("Built for Growth.");
    expect(page).toContain("Start Free Trial");
    expect(page).toContain("Watch Demo");
    expect(page).toContain('href="register/"');
    expect(page).toContain('href="#features"');
  });

  it("shows the fifteen requested modules in order and preserves availability boundaries", () => {
    const moduleTitles = [
      ...page.matchAll(/<h3 class="mc-module-title">([^<]+)<\/h3>/g),
    ].map(([, title]) => title.replaceAll("&amp;", "&"));
    expect(moduleTitles).toEqual([
      "Business Manager",
      "Sales & POS",
      "Inventory Management",
      "Purchasing & Suppliers",
      "Finance & Accounting",
      "HR & Payroll",
      "Industry-Specific Modules",
      "Reporting & Analytics",
      "OneCore AI",
      "Customer Management & CRM",
      "Product & Service Catalog",
      "Notifications & Communications",
      "Workflow Automation",
      "Webhooks & Integrations",
      "Business Dashboard",
    ]);
    expect(page).toContain("Module availability depends on your organization");
    expect(page).toContain("Business Growth");
    expect(page).toContain("Illustrative preview");
    expect(page).toContain("Built for Every Stage of Your Business");
    expect(page).toContain("Explore All Features");
    expect(page).toContain(
      'data-src="./assets/images/hero-business-owner.webp.png"',
    );
    expect(page).toContain('data-src="./assets/images/business-dashboard.png"');
    expect(homepageScript).toContain('slot.dataset.imageState = "missing"');
    expect(homepageScript).toContain('slot.dataset.imageState = "loaded"');
  });

  it("keeps links on verified destinations and describes unsupported pricing honestly", () => {
    const normalizedPage = page.replace(/\s+/g, " ");
    expect(page).toContain("Public plan details");
    expect(normalizedPage).toContain(
      "does not create an owner login or activate a workspace",
    );
    expect(page).not.toMatch(/fake|sample data|demo metrics/i);
    expect(page).not.toMatch(/https?:\/\/(?!localhost)/i);
    for (const [, anchor] of page.matchAll(/href="#([^"]+)"/g)) {
      expect(page).toContain(`id="${anchor}"`);
    }
  });

  it("uses responsive page-scoped layout and an accessible menu/image controller", () => {
    expect(homepageStyles).toContain(
      "grid-template-columns: repeat(5, minmax(0, 1fr))",
    );
    expect(homepageStyles).toContain(
      "grid-template-columns: repeat(4, minmax(0, 1fr))",
    );
    expect(homepageStyles).toContain(
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    );
    expect(homepageStyles).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    expect(homepageStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(homepageStyles).toContain("prefers-reduced-motion: reduce");
    expect(homepageScript).toContain('event.key === "Escape"');
    expect(homepageScript).toContain('menuToggle.setAttribute("aria-expanded"');
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
