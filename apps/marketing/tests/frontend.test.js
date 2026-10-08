import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");

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
  });

  it("states unavailable product, pricing, and registration boundaries honestly", () => {
    expect(page).toContain("Product-specific business modules are not yet");
    expect(page).toContain("Public plan details");
    expect(page).toContain("self-service registration");
    expect(page).not.toMatch(/fake|sample data|demo metrics/i);
    expect(page).not.toMatch(/https?:\/\/(?!localhost)/i);
  });
});
