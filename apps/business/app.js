import { ApiError, createApiClient } from "../../packages/ui/src/api-client.js";
import { announce, setTheme } from "../../packages/ui/src/elements.js";

const apiBase =
  document
    .querySelector('meta[name="onecore-api-base"]')
    ?.getAttribute("content") ?? "";
const api = createApiClient(apiBase);
const authView = document.querySelector("#auth-view");
const loadingView = document.querySelector("#loading-view");
const errorView = document.querySelector("#error-view");
const appView = document.querySelector("#app-view");
const authMessage = document.querySelector("#auth-message");
const appError = document.querySelector("#app-error");
const loginForm = document.querySelector("#login-form");
const passwordForm = document.querySelector("#password-form");
const organizationSelect = document.querySelector("#organization-select");
const branchSelect = document.querySelector("#branch-select");
const branchField = document.querySelector("#branch-field");
const userLabel = document.querySelector("#user-label");
const organizationSummary = document.querySelector("#organization-summary");
const sidebar = document.querySelector("#app-sidebar");
const menuToggle = document.querySelector("#menu-toggle");
const themeToggle = document.querySelector("#theme-toggle");
const themeOptions = ["system", "light", "dark"];
let currentTheme = 0;
let currentSession;

function show(element) {
  element.hidden = false;
}

function hide(element) {
  element.hidden = true;
}

function errorMessage(error) {
  if (error instanceof ApiError) return error.message;
  return "The request could not be completed. Please try again.";
}

function setFormPending(form, pending, submitLabel, pendingLabel) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = pending;
  button.textContent = pending ? pendingLabel : submitLabel;
  form.setAttribute("aria-busy", String(pending));
}

function selectView(view) {
  const selected = view === "security" ? "security" : "overview";
  document.querySelector("#overview-view").hidden = selected !== "overview";
  document.querySelector("#security-view").hidden = selected !== "security";
  document.querySelectorAll("[data-view]").forEach((link) => {
    if (link.dataset.view === selected) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
  sidebar.dataset.open = "false";
  menuToggle.setAttribute("aria-expanded", "false");
}

function renderSession(session) {
  currentSession = session;
  hide(loadingView);
  hide(errorView);
  hide(authView);
  show(appView);
  userLabel.textContent = session.user.email;

  organizationSelect.replaceChildren();
  const noOrganization = document.createElement("option");
  noOrganization.value = "";
  noOrganization.textContent = "Choose organization";
  organizationSelect.append(noOrganization);
  for (const membership of session.memberships) {
    const option = document.createElement("option");
    option.value = membership.organizationId;
    option.textContent = membership.name;
    organizationSelect.append(option);
  }
  organizationSelect.value = session.organization?.organizationId ?? "";
  organizationSelect.disabled = session.memberships.length === 0;

  branchSelect.replaceChildren();
  const noBranch = document.createElement("option");
  noBranch.value = "";
  noBranch.textContent = "Choose branch";
  branchSelect.append(noBranch);
  for (const branch of session.availableBranches) {
    const option = document.createElement("option");
    option.value = branch.branchId;
    option.textContent = branch.name;
    branchSelect.append(option);
  }
  branchSelect.value = session.branch?.branchId ?? "";
  branchField.hidden =
    !session.organization || session.availableBranches.length === 0;
  organizationSummary.textContent = session.organization
    ? `You are working in ${session.organization.name}${session.branch ? ` · ${session.availableBranches.find((branch) => branch.branchId === session.branch.branchId)?.name ?? "Selected branch"}` : ""}.`
    : "Choose an organization you belong to. Access is verified by OneCore.";
  document.querySelector("#workspace-empty").hidden = Boolean(
    session.organization,
  );
  document.querySelector("#modules-empty").hidden = !session.organization;
  selectView(location.hash.slice(1));
}

async function refreshSession() {
  hide(authView);
  hide(errorView);
  hide(appView);
  hide(appError);
  show(loadingView);
  try {
    renderSession(await api.request("/auth/session"));
  } catch (error) {
    hide(loadingView);
    if (error instanceof ApiError && error.status === 401) {
      show(authView);
      return;
    }
    document.querySelector("#service-error-message").textContent =
      errorMessage(error);
    show(errorView);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hide(authMessage);
  if (!loginForm.reportValidity()) return;
  setFormPending(loginForm, true, "Sign in", "Signing in…");
  const values = new FormData(loginForm);
  try {
    await api.request("/auth/login", {
      method: "POST",
      body: {
        email: values.get("email"),
        password: values.get("password"),
      },
    });
    loginForm.reset();
    await refreshSession();
  } catch (error) {
    authMessage.textContent = errorMessage(error);
    show(authMessage);
  } finally {
    setFormPending(loginForm, false, "Sign in", "Signing in…");
  }
});

organizationSelect.addEventListener("change", async () => {
  if (!organizationSelect.value || !currentSession) {
    organizationSelect.value =
      currentSession?.organization?.organizationId ?? "";
    return;
  }
  organizationSelect.disabled = true;
  try {
    await api.request("/auth/organization", {
      method: "POST",
      body: { organizationId: organizationSelect.value },
    });
    await refreshSession();
    announce("Organization context updated.", "success");
  } catch (error) {
    appError.textContent = errorMessage(error);
    show(appError);
    organizationSelect.value =
      currentSession.organization?.organizationId ?? "";
  } finally {
    organizationSelect.disabled = false;
  }
});

branchSelect.addEventListener("change", async () => {
  if (!branchSelect.value || !currentSession?.organization) {
    branchSelect.value = currentSession?.branch?.branchId ?? "";
    return;
  }
  branchSelect.disabled = true;
  try {
    await api.request("/auth/branch", {
      method: "POST",
      body: { branchId: branchSelect.value },
    });
    await refreshSession();
    announce("Branch context updated.", "success");
  } catch (error) {
    appError.textContent = errorMessage(error);
    show(appError);
    branchSelect.value = currentSession.branch?.branchId ?? "";
  } finally {
    branchSelect.disabled = false;
  }
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#password-message");
  hide(message);
  if (!passwordForm.reportValidity()) return;
  const values = new FormData(passwordForm);
  if (values.get("currentPassword") === values.get("newPassword")) {
    message.className = "oc-alert oc-alert--error";
    message.textContent =
      "Choose a new password different from your current password.";
    show(message);
    return;
  }
  setFormPending(passwordForm, true, "Update password", "Updating password…");
  try {
    await api.request("/auth/password/change", {
      method: "POST",
      body: {
        currentPassword: values.get("currentPassword"),
        newPassword: values.get("newPassword"),
      },
    });
    passwordForm.reset();
    announce(
      "Password updated. Sign in again with your new password.",
      "success",
    );
    await refreshSession();
  } catch (error) {
    message.className = "oc-alert oc-alert--error";
    message.textContent = errorMessage(error);
    show(message);
  } finally {
    setFormPending(
      passwordForm,
      false,
      "Update password",
      "Updating password…",
    );
  }
});

document.querySelector("#sign-out").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api.request("/auth/logout", { method: "POST", body: {} });
    currentSession = undefined;
    await refreshSession();
  } catch (error) {
    appError.textContent = errorMessage(error);
    show(appError);
  } finally {
    button.disabled = false;
  }
});

document
  .querySelector("#retry-session")
  .addEventListener("click", refreshSession);
window.addEventListener("hashchange", () => selectView(location.hash.slice(1)));
menuToggle.addEventListener("click", () => {
  const expanded = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!expanded));
  sidebar.dataset.open = String(!expanded);
});
document.addEventListener("keydown", (event) => {
  if (
    event.key !== "Escape" ||
    menuToggle.getAttribute("aria-expanded") !== "true"
  ) {
    return;
  }
  menuToggle.setAttribute("aria-expanded", "false");
  sidebar.dataset.open = "false";
  menuToggle.focus();
});
themeToggle.addEventListener("click", () => {
  currentTheme = (currentTheme + 1) % themeOptions.length;
  const theme = themeOptions[currentTheme];
  setTheme(theme);
  themeToggle.textContent = `Theme: ${theme}`;
});

void refreshSession();
