import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const application = await readFile(
  new URL("../app.js", import.meta.url),
  "utf8",
);
const superadminApplication = await readFile(
  new URL("../../superadmin/app.js", import.meta.url),
  "utf8",
);
const supportApplication = await readFile(
  new URL("../../support/app.js", import.meta.url),
  "utf8",
);
const pos = await readFile(new URL("../pos.js", import.meta.url), "utf8");
const setupPage = await readFile(
  new URL("../setup.html", import.meta.url),
  "utf8",
);
const setupScript = await readFile(
  new URL("../setup.js", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../../../packages/ui/styles.css", import.meta.url),
  "utf8",
);

describe("authenticated business shell", () => {
  it("uses password-only success and the shared MFA-required flow across authenticated apps", () => {
    const applications = [
      [application, "refreshSession"],
      [superadminApplication, "loadApplications"],
      [supportApplication, "loadSession"],
    ];

    for (const [source, bootstrap] of applications) {
      expect(source).toContain("createMfaLoginFlow");
      expect(source).toContain('/auth/login');
      expect(source).toContain("mfaLogin.begin");
      expect(source).toContain(`onAuthenticated: ${bootstrap}`);
    }
  });

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

  describe("first Owner credential setup page", () => {
    it("keeps the one-time token out of persistent browser storage and requires matching passwords", () => {
      expect(setupPage).toContain('name="referrer" content="no-referrer"');
      expect(setupPage).toContain('autocomplete="new-password"');
      expect(setupScript).toContain("history.replaceState(null,");
      expect(setupScript).toContain('"/auth/owner-credential-setup"');
      expect(setupScript).toContain(
        "password !== form.elements.passwordConfirm.value",
      );
      expect(setupScript).not.toMatch(/localStorage|sessionStorage|console\./);
    });
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
    expect(application).not.toMatch(/localStorage/);
    expect(application).not.toMatch(
      /["'`]\/(?:finance|payroll|crm|hr)(?:\/|["'`?])/i,
    );
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
    expect(application).toContain("function loadMemberBranchPanel");
    expect(application).toContain(
      "/members/${encodeURIComponent(member.id)}/roles",
    );
    expect(application).toContain(
      "/members/${encodeURIComponent(member.id)}/branches",
    );
    expect(application).toContain("result.capabilities?.canAssign === true");
    expect(application).toContain("result.capabilities?.canRemove === true");
    expect(application).toContain("result.availableBranches");
    expect(application).toContain('result.branchAccessMode === "ALL"');
    expect(application).toContain(
      'method: "POST", body: { branchIds: [select.value] }',
    );
    expect(application).toContain('memberText("member.branchUpdated")');
    expect(application).toContain('memberText("member.branchesAccessDenied")');
    expect(application).toContain('memberText("member.allModeReadOnly")');
    expect(application).toContain("result.capabilities?.canRemove === true");
    expect(application).toContain("result.capabilities?.canAssign === true");
    expect(application).toContain(
      "currentSession !== session || !panel.isConnected",
    );
    expect(application).toContain('method: "POST"');
    expect(application).toContain('method: "DELETE"');
    expect(application).toContain("Watumiaji na wanachama");
    expect(page).toContain('id="members-nav"');
    expect(application).not.toMatch(/\/organizations\/[^`"]+\/audit/);
    expect(application).not.toContain("version.body");
    expect(application).not.toContain("secretReference");
    expect(application).not.toMatch(
      /["'`]\/(?:finance|payroll|crm|hr|ai)(?:\/|["'`?])/i,
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

  it("connects branch administration to permission-aware APIs", () => {
    expect(application).toContain('"branches-nav"');
    expect(application).toContain(
      "/organizations/${encodeURIComponent(organizationId)}/branches?limit=20&offset=${branchOffset}",
    );
    expect(application).toContain("result.capabilities?.canCreate === true");
    expect(application).toContain("result.capabilities?.canUpdate === true");
    expect(application).toContain('method: "POST"');
    expect(application).toContain('method: "PATCH"');
    expect(application).toContain('branchText("branch.empty")');
    expect(application).toContain('branchText("branch.loading")');
    expect(application).toContain('branchText("branch.denied")');
    expect(application).toContain('retry.textContent = "Retry"');
    expect(application).not.toContain("session.permissions");
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
    expect(application).not.toMatch(/localStorage/);
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
    expect(application).toContain("response.capabilities ?? {}");
    expect(application).toContain("capabilities.canCreate === true");
    expect(application).toContain("capabilities.canUpdate === true");
    expect(application).toContain("capabilities.canDelete === true");
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
    expect(application).toContain(
      "result.permissions?.canUpdateSettings === true",
    );
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

  it("exposes only an authenticated, catalog-backed POS draft workspace", () => {
    expect(page).toContain('id="pos-nav"');
    expect(page).toContain('href="#pos" data-view="pos"');
    expect(application).toContain("function loadPosWorkspace");
    expect(application).toContain(
      "`/organizations/${encodeURIComponent(organizationId)}/business/catalog`",
    );
    expect(application).toContain('status: "ACTIVE"');
    expect(application).toContain(
      'searchInput.placeholder = "Name or SKU/reference"',
    );
    expect(application).toContain(
      "authenticatedRequest(\n      `${posCatalogEndpoint(organizationId)}?${params}`",
    );
    expect(application).toContain("requestError.status === 403");
    expect(application).toContain("currentSession !== session");
    expect(application).toContain("resetPosWorkspaceState()");
    expect(application).toContain("function submitPosCheckout");
    expect(application).toContain(
      "request: (path, options) => authenticatedRequest(path, options)",
    );
    expect(application).toContain("globalThis.crypto.randomUUID()");
    expect(application).toContain(
      'appendText(confirmation, "h3", "Unpaid — OPEN"',
    );
    expect(application).toContain("posSaleConfirmation.total");
    expect(pos).toContain(
      "/organizations/${encodeURIComponent(attempt.organizationId)}/sales",
    );
    expect(pos).toContain("expectedStatus: 201");
    expect(pos).toContain('headers: { "Idempotency-Key": attempt.key }');
    expect(pos).toContain(
      "storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(attempt))",
    );
    expect(application).toContain(
      'const canStartCheckout = attemptState.kind === "NONE" && posCart.size > 0;',
    );
    expect(application).toContain(
      "checkout.disabled =\n      posCheckoutSubmitting ||\n      !context.organizationId",
    );
    expect(application).not.toContain("checkout.disabled =\n      locked ||");
    const checkoutFlowStart = application.indexOf(
      "async function submitPosCheckout",
    );
    const confirmedStart = application.indexOf(
      'if (result.kind === "SUCCESS")',
      checkoutFlowStart,
    );
    const failureStart = application.indexOf("} else {", confirmedStart);
    expect(application.slice(confirmedStart, failureStart)).toContain(
      "posCart.clear()",
    );
    expect(application.slice(failureStart, failureStart + 180)).not.toContain(
      "posCart.clear()",
    );
    expect(application).toContain(
      "resetPosWorkspaceState({ clearCart: false })",
    );
    expect(application).toContain(
      "Stock availability is not provided by this API.",
    );
    const checkoutStart = application.indexOf(
      "async function submitPosCheckout",
    );
    const checkoutEnd = application.indexOf(
      "function renderPosWorkspace",
      checkoutStart,
    );
    expect(application.slice(checkoutStart, checkoutEnd)).not.toMatch(
      /\/(payments|transactions|receipts|inventory)\b/i,
    );
    expect(application).not.toMatch(/localStorage/);
    expect(application).toContain("globalThis.sessionStorage");
    expect(application).not.toMatch(
      /payment (?:completed|received)|stock reserved|inventory decremented/i,
    );
    expect(styles).toContain(".oc-pos-layout");
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).toContain(".oc-pos-cart");
  });

  it("loads branch inventory from authorized catalog and stock APIs without inferring valuation or reorder levels", () => {
    expect(page).toMatch(
      /id="inventory-nav"[\s\S]*?href="#inventory"[\s\S]*?data-view="inventory"/,
    );
    expect(application).toContain("async function loadInventoryView");
    expect(application).toContain("/business/catalog?${catalogQuery}");
    expect(application).toContain("/inventory/stock?${stockQuery}");
    expect(application).toContain(
      'catalogQuery.set("search", inventorySearch)',
    );
    expect(application).toContain('"OUT_OF_STOCK"');
    expect(application).toContain("No active products match this search.");
    expect(application).toContain("Reorder thresholds");
    expect(application).toContain("price-derived valuation");
    expect(application).toContain("session?.branch?.branchId");
  });

  it("reads Sales history and detail without adding payment or receipt behavior", () => {
    expect(page).toContain('id="sales-nav"');
    expect(page).toContain('href="#sales" data-view="sales"');
    expect(application).toContain("async function loadSalesView");
    expect(application).toContain(
      "/sales?limit=${salesPageSize}&offset=${salesOffset}",
    );
    expect(application).toContain(
      "/sales/${encodeURIComponent(selectedSaleId)}",
    );
    expect(application).toContain("This sale is unpaid.");
    expect(application).toContain(
      "Payment completion and receipt issuance are not supported",
    );
    expect(application).toContain(
      'if (sale.status === "OPEN" && capabilities.canCancel === true)',
    );
    expect(application).toContain('cancel.textContent = "Cancel unpaid sale"');
    expect(application).toContain("async function cancelSaleFromDetails");
    expect(application).toContain(
      "/sales/${encodeURIComponent(sale.id)}/cancel",
    );
    expect(application).toContain('result.sale.status !== "CANCELLED"');
    expect(application).toContain("await loadSalesView(container)");
    expect(application).toContain("Any stock reservation was released.");
    expect(application).not.toMatch(/\/(payments|receipts)\b/);
    expect(application).toContain('"sales-nav"');
  });

  it("provides explicit unavailable routes without inventing unsupported module records", () => {
    for (const [view, navigationId] of [
      ["finance", "finance-nav"],
      ["companies", "companies-nav"],
      ["hr", "hr-nav"],
      ["payroll", "payroll-nav"],
    ]) {
      expect(page).toContain(`id="${navigationId}"`);
      expect(page).toContain(`href="#${view}" data-view="${view}"`);
      expect(application).toContain(`${view}: {`);
    }
    expect(application).toContain(
      "A distinct company CRM model and API are not available",
    );
    expect(application).toContain("Open supported customer records");
    expect(application).toContain(
      "Payroll periods, calculations, approvals, and payslips",
    );
    expect(application).toContain('role", "status"');
  });
});
