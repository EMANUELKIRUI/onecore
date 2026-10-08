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
    expect(application).not.toMatch(
      /\/organizations\/[^`"]+\/(branches|members|audit)/,
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
  });
});
