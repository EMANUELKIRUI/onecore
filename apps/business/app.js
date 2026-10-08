import { ApiError, createApiClient } from "../../packages/ui/src/api-client.js";
import { announce, setTheme } from "../../packages/ui/src/elements.js";
import {
  formatDateTime,
  resolveLocale,
  translate,
} from "../../packages/ui/src/localization.js";

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
const workflowLocale = resolveLocale(globalThis.navigator.language);
const workflowMessages = {
  en: {
    "workflow.nav": "Workflow activity",
    "workflow.eyebrow": "Automation",
    "workflow.title": "Workflow activity",
    "workflow.description":
      "Review recent event-triggered workflow executions and their action status.",
    "workflow.refresh": "Refresh activity",
    "workflow.loading": "Loading workflow activity…",
    "workflow.empty": "No workflow executions are available.",
    "workflow.started": "Started",
    "workflow.completed": "Completed",
    "workflow.event": "Event",
    "workflow.status": "Status",
    "workflow.actions": "Actions",
    "workflow.noActions": "No actions recorded.",
    "workflow.failure": "Failure",
    "workflow.accessDenied":
      "You are not authorized to view workflow activity.",
    "workflow.loadFailed":
      "Workflow activity could not be loaded. Please try again.",
    "workflow.status.PENDING": "Pending",
    "workflow.status.RUNNING": "Running",
    "workflow.status.RETRYING": "Retrying",
    "workflow.status.SUCCEEDED": "Succeeded",
    "workflow.status.FAILED": "Failed",
    "workflow.status.SKIPPED": "Skipped",
    "workflow.action.NOTIFICATION": "In-app notification",
  },
  sw: {
    "workflow.nav": "Shughuli za mtiririko wa kazi",
    "workflow.eyebrow": "Uendeshaji otomatiki",
    "workflow.title": "Shughuli za mtiririko wa kazi",
    "workflow.description":
      "Kagua utekelezaji wa hivi karibuni wa mtiririko na hali ya vitendo vyake.",
    "workflow.refresh": "Onyesha upya shughuli",
    "workflow.loading": "Inapakia shughuli za mtiririko wa kazi…",
    "workflow.empty": "Hakuna utekelezaji wa mtiririko wa kazi unaopatikana.",
    "workflow.started": "Ilianza",
    "workflow.completed": "Ilikamilika",
    "workflow.event": "Tukio",
    "workflow.status": "Hali",
    "workflow.actions": "Vitendo",
    "workflow.noActions": "Hakuna vitendo vilivyorekodiwa.",
    "workflow.failure": "Hitilafu",
    "workflow.accessDenied":
      "Huna ruhusa ya kuona shughuli za mtiririko wa kazi.",
    "workflow.loadFailed":
      "Haikuwezekana kupakia shughuli. Tafadhali jaribu tena.",
    "workflow.status.PENDING": "Inasubiri",
    "workflow.status.RUNNING": "Inaendelea",
    "workflow.status.RETRYING": "Inajaribu tena",
    "workflow.status.SUCCEEDED": "Imefanikiwa",
    "workflow.status.FAILED": "Imeshindwa",
    "workflow.status.SKIPPED": "Imepitwa",
    "workflow.action.NOTIFICATION": "Arifa ya ndani ya programu",
  },
};
let currentTheme = 0;
let currentSession;
let workflowLoadSequence = 0;

function workflowText(key) {
  return translate(key, {
    locale: workflowLocale,
    messages: workflowMessages,
    fallbackText: key,
  });
}

function workflowStatusLabel(status) {
  return workflowText(`workflow.status.${status}`);
}

function setWorkflowText() {
  document.querySelector("#workflow-nav").textContent =
    workflowText("workflow.nav");
  document.querySelector("#workflow-eyebrow").textContent =
    workflowText("workflow.eyebrow");
  document.querySelector("#workflows-title").textContent =
    workflowText("workflow.title");
  document.querySelector("#workflow-description").textContent = workflowText(
    "workflow.description",
  );
  document.querySelector("#workflow-refresh").textContent =
    workflowText("workflow.refresh");
  document.querySelector("#workflow-loading").textContent =
    workflowText("workflow.loading");
  document.querySelector("#workflow-empty").textContent =
    workflowText("workflow.empty");
}

function updateWorkflowNavigation(session) {
  const navigation = document.querySelector("#workflow-nav");
  const organizationId = session.organization?.organizationId;
  if (!organizationId) {
    navigation.hidden = true;
    return;
  }
  void api
    .request(
      `/organizations/${encodeURIComponent(organizationId)}/workflow-executions?limit=1`,
    )
    .then(() => {
      if (currentSession?.organization?.organizationId === organizationId) {
        navigation.hidden = false;
      }
    })
    .catch((error) => {
      if (currentSession?.organization?.organizationId !== organizationId) {
        return;
      }
      navigation.hidden =
        error instanceof ApiError && [401, 403].includes(error.status);
      if (!navigation.hidden) show(navigation);
    });
}

function appendWorkflowField(container, label, value) {
  const row = document.createElement("p");
  const term = document.createElement("strong");
  term.textContent = `${label}: `;
  row.append(term, document.createTextNode(value));
  container.append(row);
}

function renderWorkflowExecutions(executions) {
  const list = document.querySelector("#workflow-list");
  const empty = document.querySelector("#workflow-empty");
  list.replaceChildren();
  empty.hidden = executions.length !== 0;
  for (const execution of executions) {
    const card = document.createElement("article");
    card.className = "oc-card oc-stack";
    const heading = document.createElement("h2");
    heading.className = "oc-section-title";
    heading.textContent = `${execution.workflowName} · v${execution.version}`;
    card.append(heading);
    appendWorkflowField(
      card,
      workflowText("workflow.event"),
      execution.eventType,
    );
    appendWorkflowField(
      card,
      workflowText("workflow.status"),
      workflowStatusLabel(execution.status),
    );
    appendWorkflowField(
      card,
      workflowText("workflow.started"),
      formatDateTime(new Date(execution.startedAt), { locale: workflowLocale }),
    );
    if (execution.completedAt) {
      appendWorkflowField(
        card,
        workflowText("workflow.completed"),
        formatDateTime(new Date(execution.completedAt), {
          locale: workflowLocale,
        }),
      );
    }
    if (execution.failureCode) {
      appendWorkflowField(
        card,
        workflowText("workflow.failure"),
        execution.failureCode,
      );
    }
    const actionsTitle = document.createElement("h3");
    actionsTitle.className = "oc-section-title";
    actionsTitle.textContent = workflowText("workflow.actions");
    card.append(actionsTitle);
    const actions = Array.isArray(execution.actions) ? execution.actions : [];
    if (actions.length === 0) {
      const noActions = document.createElement("p");
      noActions.className = "oc-muted";
      noActions.textContent = workflowText("workflow.noActions");
      card.append(noActions);
    } else {
      const actionList = document.createElement("ul");
      for (const action of actions) {
        const item = document.createElement("li");
        const actionName =
          workflowText(`workflow.action.${action.type}`) ===
          `workflow.action.${action.type}`
            ? action.type
            : workflowText(`workflow.action.${action.type}`);
        item.textContent = `${actionName} — ${workflowStatusLabel(action.status)}`;
        if (action.failureCode) {
          item.textContent += ` (${workflowText("workflow.failure")}: ${action.failureCode})`;
        }
        actionList.append(item);
      }
      card.append(actionList);
    }
    list.append(card);
  }
}

async function loadWorkflowExecutions() {
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  const sequence = ++workflowLoadSequence;
  const loading = document.querySelector("#workflow-loading");
  const error = document.querySelector("#workflow-error");
  if (!organizationId) {
    loading.hidden = true;
    error.textContent = workflowText("workflow.accessDenied");
    show(error);
    return;
  }
  hide(error);
  show(loading);
  try {
    const result = await api.request(
      `/organizations/${encodeURIComponent(organizationId)}/workflow-executions?limit=50`,
    );
    if (
      sequence !== workflowLoadSequence ||
      currentSession?.organization?.organizationId !== organizationId
    ) {
      return;
    }
    renderWorkflowExecutions(
      Array.isArray(result.executions) ? result.executions : [],
    );
  } catch (requestError) {
    if (sequence !== workflowLoadSequence) return;
    error.textContent =
      requestError instanceof ApiError && requestError.status === 401
        ? workflowText("workflow.accessDenied")
        : requestError instanceof ApiError && requestError.status === 403
          ? workflowText("workflow.accessDenied")
          : workflowText("workflow.loadFailed");
    show(error);
  } finally {
    if (sequence === workflowLoadSequence) hide(loading);
  }
}

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
  const selected = ["security", "workflows"].includes(view) ? view : "overview";
  document.querySelector("#overview-view").hidden = selected !== "overview";
  document.querySelector("#security-view").hidden = selected !== "security";
  document.querySelector("#workflows-view").hidden = selected !== "workflows";
  document.querySelectorAll("[data-view]").forEach((link) => {
    if (link.dataset.view === selected) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
  sidebar.dataset.open = "false";
  menuToggle.setAttribute("aria-expanded", "false");
  if (selected === "workflows") void loadWorkflowExecutions();
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
  updateWorkflowNavigation(session);
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
document
  .querySelector("#workflow-refresh")
  .addEventListener("click", loadWorkflowExecutions);
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

setWorkflowText();
void refreshSession();
