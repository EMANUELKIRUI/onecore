import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const application = await readFile(
  new URL("../app.js", import.meta.url),
  "utf8",
);

describe("authenticated business shell", () => {
  it("exposes accessible workspace, profile, security, and history boundaries", () => {
    for (const id of [
      "auth-view",
      "app-view",
      "overview-view",
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
});
