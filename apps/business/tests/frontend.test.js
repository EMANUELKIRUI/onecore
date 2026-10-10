import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const application = await readFile(
  new URL("../app.js", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../../../packages/ui/styles.css", import.meta.url),
  "utf8",
);

describe("authenticated business shell", () => {
  it("exposes accessible workspace, profile, security, and history boundaries", () => {
    for (const id of [
      "auth-view",
      "app-view",
      "overview-view",
      "boundary-view",
      "profile-view",
      "security-view",
      "workflows-view",
      "resource-view",
      "not-found-view",
    ]) {
      expect(page).toContain(`id="${id}"`);
    }
    expect(page).toContain('aria-label="Workspace"');
    expect(page).toContain('aria-controls="app-sidebar"');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('role="alert"');
  });

  it("uses only existing session and organization-scoped APIs", () => {
    for (const path of [
      "/auth/session",
      "/auth/login",
      "/auth/logout",
      "/auth/password/change",
      "/auth/organization",
      "/auth/branch",
      "/organizations/",
      "/modules",
      "/roles",
      "/permissions",
    ]) {
      expect(application).toContain(path);
    }
    expect(application).not.toMatch(/localStorage|sessionStorage/);
    expect(application).not.toMatch(/\/(pos|inventory|finance|payroll|crm)\b/i);
  });

  it("keeps navigation subordinate to API authorization and sanitizes errors", () => {
    expect(application).toContain("updateResourceNavigation");
    expect(application).toContain("error.status === 401");
    expect(application).toContain("requestError.status === 403");
    expect(application).toContain("function errorMessage(error)");
    expect(application).toContain("The request could not be completed.");
    expect(application).not.toContain("session.permissions");
  });

  it("integrates only existing organization-scoped foundation APIs", () => {
    for (const path of [
      "/notification-preferences",
      "/communication-templates",
      "/communications/deliveries",
      "/features",
      "/workflow-executions",
      "/members",
      "/roles/",
      'method: "PATCH"',
      "/configuration",
    ]) {
      expect(application).toContain(path);
    }
    expect(application).toContain(
      "Branch choices come only from the authenticated session",
    );
    expect(application).toContain("no tenant-authorized audit read API");
    expect(application).toContain("function loadMembersView");
    expect(application).toContain("members-nav");
    expect(application).toContain("function loadMemberRolePanel");
    expect(application).toContain(
      "/members/${encodeURIComponent(member.id)}/roles",
    );
    expect(application).toContain('method: "POST"');
    expect(application).toContain('method: "DELETE"');
    expect(application).toContain("Watumiaji na wanachama");
    expect(page).toContain('id="members-nav"');
    expect(application).not.toMatch(
      /\/organizations\/[^`"]+\/(branches|audit)/,
    );
    expect(application).not.toContain("version.body");
    expect(application).not.toContain("secretReference");
    expect(application).not.toMatch(
      /\/(pos|inventory|finance|payroll|crm|ai)\b/i,
    );
  });

  it("includes account-safe dashboard previews and supported management boundaries", () => {
    expect(application).toContain("function loadDashboard(session)");
    expect(application).toContain("function renderPreferences");
    expect(application).toContain("function renderRegionalSettingsForm");
    expect(application).toContain("function renderRoleCards");
    expect(application).toContain("function loadBoundaryView(view)");
    expect(application).toContain("Business UI not implemented");
    expect(page).toContain('data-view="members"');
    expect(page).toContain('data-view="audit"');
    expect(page).toContain('aria-label="Breadcrumb"');
  });

  it("preserves semantic and responsive foundation requirements", () => {
    expect(page.match(/<main\b/g)).toHaveLength(1);
    expect(page.match(/<\/main>/g)).toHaveLength(1);
    expect(page).toContain('aria-label="Application navigation"');
    expect(page).toContain('aria-label="Current organization"');
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".oc-table-wrap");
    expect(styles).toContain(".oc-sidebar-backdrop:not([hidden])");
    expect(styles).toContain(".oc-dashboard-metrics");
  });

  it("provides a branded responsive shell and operable accessible controls", () => {
    expect(page).toContain("OneCore");
    expect(page).toContain("Business OS");
    expect(page).toContain('id="menu-toggle"');
    expect(page).toContain('id="sidebar-backdrop"');
    expect(page).toContain('aria-label="Open navigation"');
    expect(page).toContain('id="global-search-form"');
    expect(page).toContain('id="password-visibility"');
    expect(application).toContain(
      'sidebar.querySelector(".oc-nav a:not([hidden])")',
    );
    expect(application).toContain("globalSearchDialog.showModal()");
    expect(application).toContain("globalSearchSequence");
    expect(application).toContain("dashboard-workflows-link");
    expect(application).toContain("dashboard-modules-link");
    expect(styles).toContain("@media (max-width: 900px)");
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).toContain("@media (max-width: 480px)");
  });

  it("searches only authorized Business Manager customer and catalog APIs", () => {
    expect(application).toContain("businessResourceEndpoint(target.view)");
    expect(application).toContain('label: "Customer"');
    expect(application).toContain('label: "Catalog item"');
    expect(application).toContain("Promise.allSettled");
    expect(application).toContain("currentSession !== session");
    expect(application).not.toMatch(
      /sample customers|demo products|fake metrics/i,
    );
  });
});

describe("Business Manager capability boundary", () => {
  it("integrates Business Manager routes into the existing authenticated shell", () => {
    expect(page).toContain('class="oc-nav__group-label">Business Manager');
    for (const view of [
      "overview",
      "organization",
      "customers",
      "products",
      "branches",
      "workflows",
      "settings",
    ]) {
      expect(page).toContain(`data-view="${view}"`);
    }
    expect(page).toContain('id="app-view"');
    expect(page).toContain('id="loading-view"');
    expect(application).toContain('"/auth/session"');
  });

  it("uses tenant-scoped Business Manager APIs for customer and catalog CRUD", () => {
    expect(application).toContain(
      'view === "customers" ? "customers" : "catalog"',
    );
    expect(application).toContain("/business/${resource}");
    expect(application).toContain("function loadBusinessManagerView");
    expect(application).toContain("function renderBusinessForm");
    expect(application).toContain("function renderBusinessTable");
    expect(application).toContain(
      'method: options.mode === "edit" ? "PATCH" : "POST"',
    );
    expect(application).toContain('method: "DELETE"');
    expect(application).toContain("window.confirm");
    expect(application).not.toMatch(/localStorage|sessionStorage/);
    expect(application).not.toMatch(
      /customers\s*:\s*\[\s*\{|products\s*:\s*\[\s*\{/,
    );
  });

  it("handles business-resource loading, empty, forbidden, retry, pagination and context changes", () => {
    expect(application).toContain(
      '["CURRENT", "Current branch and organization-wide"]',
    );
    expect(application).toContain(
      'pattern: "(?:0|[1-9][0-9]{0,11})(?:\\\\.[0-9]{1,6})?"',
    );
    expect(application).toContain('pattern: "[A-Z]{3}"');
    const resourceSubmitStart = application.indexOf(
      'form.addEventListener("submit", async (event) => {',
      application.indexOf("async function loadBusinessManagerView"),
    );
    const resourceValuesStart = application.indexOf(
      "const values = Object.fromEntries(new FormData(form));",
      resourceSubmitStart,
    );
    expect(
      application.slice(resourceSubmitStart, resourceValuesStart),
    ).not.toContain("supportedValuesOf");
    expect(application).toContain("Loading records…");
    expect(application).toContain("Loading record…");
    expect(application).toContain(
      'No ${view === "customers" ? "customers" : "catalog items"} found.',
    );
    expect(application).toContain("requestError.status === 403");
    expect(application).toContain('button.textContent = "Retry"');
    expect(application).toContain('pagination.setAttribute("aria-label"');
    expect(application).toContain("businessResourceSequence");
    expect(application).toContain("currentSession !== session");
    expect(application).toContain("businessResourceFilters.customers = {}");
    expect(application).toContain("function clearBusinessManagerContext()");
    expect(application).toContain("clearBusinessManagerContext();");
    expect(application).toContain("reloadBusinessManagerViewIfSelected();");
    expect(page).toContain('id="customers-nav"');
    expect(page).toContain('id="products-nav"');
  });

  it("uses the existing configuration contract for supported profile mutations", () => {
    expect(application).toContain(
      "`/organizations/${encodeURIComponent(organizationId)}/configuration`",
    );
    expect(application).toContain('method: "PATCH"');
    for (const field of [
      "legalName",
      "registrationNumber",
      "taxNumber",
      "countryCode",
      "currencyCode",
      "timezone",
      "locale",
    ]) {
      expect(application).toContain(field);
    }
    expect(application).toContain('announce("Organization settings saved."');
    expect(application).toContain(
      "error.textContent = errorMessage(requestError)",
    );
    expect(application).toContain(
      "The API validates and authorizes every update.",
    );
    expect(application).toContain("function renderBusinessProfileForm");
    expect(application).toContain("body: { businessProfile }");
    for (const field of [
      "contactEmail",
      "contactPhone",
      "website",
      "countryCode",
      "region",
      "city",
      "address",
    ]) {
      expect(application).toContain(`name: "${field}"`);
    }
    expect(application).toContain("Organization lifecycle status");
  });

  it("reuses server-verified branch context and registry entitlements", () => {
    expect(application).toContain("session.availableBranches");
    expect(application).toContain('"/auth/branch"');
    expect(application).toContain('authenticatedRequest("/modules")');
    expect(application).toContain("/modules`");
    expect(application).toContain("entitlements.get(item.name)");
    expect(application).toContain("organizationId");
    expect(application).toContain("customers-nav");
    expect(application).toContain("products-nav");
  });

  it("limits activity to the workflow API and distinguishes missing audit reads", () => {
    expect(application).toContain("/workflow-executions");
    expect(application).toContain("no tenant-authorized audit read API");
    expect(application).toContain("workflow activity");
    expect(application).toContain("requestError.status === 403");
    expect(application).toContain("error.status === 404");
  });
});
