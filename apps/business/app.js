import { ApiError, createApiClient } from "../../packages/ui/src/api-client.js";
import {
  announce,
  createStatusBadge,
  setTheme,
  setBusy,
} from "../../packages/ui/src/elements.js";
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
let workflowNavigationSequence = 0;
let resourceLoadSequence = 0;
let resourceNavigationSequence = 0;
let notificationOffset = 0;
const resourceViews = {
  notifications: {
    title: "Notifications",
    description: "Notifications delivered to your signed-in account.",
    eyebrow: "Your inbox",
  },
  modules: {
    title: "Modules & access",
    description:
      "Platform capabilities and this organization’s recorded entitlements.",
    eyebrow: "Organization",
  },
  roles: {
    title: "Roles & permissions",
    description:
      "The role and permission catalogs available in this organization context.",
    eyebrow: "Access",
  },
  settings: {
    title: "Organization settings",
    description: "Verified settings currently available for this organization.",
    eyebrow: "Configuration",
  },
};

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
  const sequence = ++workflowNavigationSequence;
  const organizationId = session.organization?.organizationId;
  navigation.hidden = true;
  if (!organizationId) {
    return;
  }
  void authenticatedRequest(
    `/organizations/${encodeURIComponent(organizationId)}/workflow-executions?limit=1`,
  )
    .then(() => {
      if (
        sequence === workflowNavigationSequence &&
        currentSession === session
      ) {
        navigation.hidden = false;
      }
    })
    .catch(() => {
      if (
        sequence === workflowNavigationSequence &&
        currentSession === session
      ) {
        navigation.hidden = true;
      }
    });
}

function sessionExpired() {
  currentSession = undefined;
  hide(appView);
  hide(loadingView);
  hide(errorView);
  authMessage.textContent =
    "Your session is no longer available. Sign in to continue.";
  show(authMessage);
  show(authView);
}

async function authenticatedRequest(path, options) {
  try {
    return await api.request(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      sessionExpired();
    }
    throw error;
  }
}

function appendText(container, tagName, text, className) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  container.append(element);
  return element;
}

function renderDefinitionList(container, values) {
  const list = document.createElement("dl");
  list.className = "oc-detail-list";
  for (const [label, value] of values) {
    if (value === null || value === undefined || value === "") continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = String(value);
    list.append(term, detail);
  }
  container.append(list);
}

function renderSimpleTable(container, headers, rows) {
  const wrapper = document.createElement("div");
  wrapper.className = "oc-table-wrap";
  const table = document.createElement("table");
  table.className = "oc-table";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of headers) {
    appendText(headerRow, "th", label);
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    for (const value of row) {
      appendText(tableRow, "td", String(value ?? "—"));
    }
    body.append(tableRow);
  }
  table.append(head, body);
  wrapper.append(table);
  container.append(wrapper);
}

function renderNotifications(container, notifications, organizationId) {
  if (notifications.length === 0) return false;
  for (const notification of notifications) {
    const card = document.createElement("article");
    card.className = "oc-card oc-stack";
    const header = document.createElement("div");
    header.className = "oc-cluster";
    appendText(header, "h2", notification.title, "oc-section-title");
    header.append(
      createStatusBadge(
        notification.readAt ? "Read" : "Unread",
        notification.readAt ? "neutral" : "info",
      ),
    );
    card.append(header);
    appendText(card, "p", notification.body);
    appendText(
      card,
      "time",
      formatDateTime(new Date(notification.createdAt), {
        locale: workflowLocale,
      }),
      "oc-muted",
    ).dateTime = notification.createdAt;
    if (!notification.readAt) {
      const markRead = document.createElement("button");
      markRead.type = "button";
      markRead.className = "oc-button oc-button--secondary";
      markRead.textContent = "Mark as read";
      markRead.addEventListener("click", async () => {
        setBusy(markRead, true);
        try {
          await authenticatedRequest(
            `/organizations/${encodeURIComponent(organizationId)}/notifications/${encodeURIComponent(notification.id)}/read`,
            { method: "POST", body: {} },
          );
          await loadResourceView("notifications");
          announce("Notification marked as read.", "success");
        } catch (error) {
          announce(errorMessage(error), "error");
        } finally {
          if (markRead.isConnected) setBusy(markRead, false);
        }
      });
      card.append(markRead);
    }
    container.append(card);
  }
  return true;
}

function renderResource(view, result, container) {
  const organizationId = currentSession?.organization?.organizationId;
  if (view === "notifications") {
    return renderNotifications(
      container,
      Array.isArray(result.notifications) ? result.notifications : [],
      organizationId,
    );
  }
  if (view === "modules") {
    const entitlements = new Map(
      (result.entitlements ?? []).map((item) => [item.moduleName, item]),
    );
    const modules = result.catalog ?? [];
    renderSimpleTable(
      container,
      ["Capability", "Availability", "Organization entitlement"],
      modules.map((item) => [
        item.displayName,
        item.available && item.lifecycle === "AVAILABLE"
          ? "Available"
          : "Not available",
        entitlements.get(item.name)?.status ?? "Not enabled",
      ]),
    );
    return modules.length > 0;
  }
  if (view === "roles") {
    const roles = result.roles ?? [];
    const permissions = result.permissions ?? [];
    if (roles.length > 0) {
      appendText(container, "h2", "Organization roles", "oc-section-title");
      renderSimpleTable(
        container,
        ["Role", "Status", "Type", "Description"],
        roles.map((role) => [
          role.name,
          role.status,
          role.isSystem ? "System" : "Organization",
          role.description,
        ]),
      );
    }
    if (permissions.length > 0) {
      appendText(container, "h2", "Permission catalog", "oc-section-title");
      renderSimpleTable(
        container,
        ["Permission", "Module", "Description"],
        permissions.map((permission) => [
          permission.key,
          permission.module,
          permission.description,
        ]),
      );
    }
    return roles.length + permissions.length > 0;
  }
  if (view === "settings") {
    const { organization, settings, business, capabilities } = result;
    appendText(container, "h2", "Organization", "oc-section-title");
    renderDefinitionList(container, [
      ["Name", organization?.name],
      ["Industry", organization?.industry],
      ["Deployment type", organization?.deploymentType],
      ["Legal name", business?.legalName],
    ]);
    appendText(container, "h2", "Regional settings", "oc-section-title");
    renderDefinitionList(container, [
      ["Country", settings?.countryCode],
      ["Currency", settings?.currencyCode],
      ["Time zone", settings?.timezone],
      ["Locale", settings?.locale],
    ]);
    appendText(
      container,
      "h2",
      "Configuration capabilities",
      "oc-section-title",
    );
    renderDefinitionList(
      container,
      Object.entries(capabilities ?? {}).map(([key, value]) => [
        key,
        value ? "Available" : "Not available",
      ]),
    );
    appendText(
      container,
      "p",
      "Settings are shown read-only here. This application does not yet provide a settings editor.",
      "oc-help",
    );
    return true;
  }
  return false;
}

async function loadResourceView(view) {
  const metadata = resourceViews[view];
  if (!metadata) return;
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  const sequence = ++resourceLoadSequence;
  const loading = document.querySelector("#resource-loading");
  const error = document.querySelector("#resource-error");
  const empty = document.querySelector("#resource-empty");
  const content = document.querySelector("#resource-content");
  document.querySelector("#resource-eyebrow").textContent = metadata.eyebrow;
  document.querySelector("#resource-title").textContent = metadata.title;
  document.querySelector("#resource-description").textContent =
    metadata.description;
  content.replaceChildren();
  hide(error);
  hide(empty);
  show(loading);
  if (!organizationId) {
    hide(loading);
    error.textContent = "Select an organization to view this information.";
    show(error);
    return;
  }
  try {
    let result;
    if (view === "notifications") {
      result = await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/notifications?limit=20&offset=${notificationOffset}`,
      );
    } else if (view === "modules") {
      const [catalog, entitlements] = await Promise.all([
        authenticatedRequest("/modules"),
        authenticatedRequest(
          `/organizations/${encodeURIComponent(organizationId)}/modules`,
        ),
      ]);
      result = { ...catalog, ...entitlements };
    } else if (view === "roles") {
      const [rolesResult, permissionsResult] = await Promise.allSettled([
        authenticatedRequest("/roles"),
        authenticatedRequest("/permissions"),
      ]);
      result = {
        roles:
          rolesResult.status === "fulfilled" ? rolesResult.value.roles : [],
        permissions:
          permissionsResult.status === "fulfilled"
            ? permissionsResult.value.permissions
            : [],
      };
      if (
        rolesResult.status === "rejected" &&
        permissionsResult.status === "rejected"
      ) {
        throw rolesResult.reason;
      }
    } else {
      result = await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/configuration`,
      );
    }
    if (sequence !== resourceLoadSequence || currentSession !== session) return;
    const hasContent = renderResource(view, result, content);
    if (!hasContent) {
      empty.textContent =
        view === "notifications"
          ? notificationOffset > 0
            ? "There are no more notifications."
            : "You do not have any notifications yet."
          : "No information is available in this organization context.";
      show(empty);
    }
    if (view === "notifications")
      renderNotificationPagination(result.notifications ?? []);
  } catch (requestError) {
    if (sequence !== resourceLoadSequence) return;
    error.textContent =
      requestError instanceof ApiError && requestError.status === 403
        ? "You are not authorized to view this information."
        : errorMessage(requestError);
    show(error);
  } finally {
    if (sequence === resourceLoadSequence) hide(loading);
  }
}

function renderNotificationPagination(notifications) {
  const content = document.querySelector("#resource-content");
  const pagination = document.createElement("nav");
  pagination.className = "oc-pagination";
  pagination.setAttribute("aria-label", "Notification pages");
  const controls = document.createElement("div");
  controls.className = "oc-pagination__controls";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "oc-button oc-button--secondary";
  previous.textContent = "Previous";
  previous.disabled = notificationOffset === 0;
  previous.addEventListener("click", () => {
    notificationOffset = Math.max(0, notificationOffset - 20);
    void loadResourceView("notifications");
  });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "oc-button oc-button--secondary";
  next.textContent = "Next";
  next.disabled = notifications.length < 20;
  next.addEventListener("click", () => {
    notificationOffset += 20;
    void loadResourceView("notifications");
  });
  controls.append(previous, next);
  pagination.append(controls);
  content.append(pagination);
}

async function updateResourceNavigation(session) {
  const organizationId = session.organization?.organizationId;
  const sequence = ++resourceNavigationSequence;
  const probes = [
    [
      "notifications-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/notifications?limit=1`,
    ],
    [
      "modules-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/modules`,
    ],
    ["roles-nav", "/roles"],
    [
      "settings-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/configuration`,
    ],
  ];
  for (const [id] of probes) document.querySelector(`#${id}`).hidden = true;
  if (!organizationId) return;
  await Promise.all(
    probes.map(async ([id, path]) => {
      if (!path) return;
      try {
        await authenticatedRequest(path);
        if (
          sequence === resourceNavigationSequence &&
          currentSession === session
        ) {
          document.querySelector(`#${id}`).hidden = false;
        }
      } catch {
        if (sequence === resourceNavigationSequence) {
          document.querySelector(`#${id}`).hidden = true;
        }
      }
    }),
  );
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
    const result = await authenticatedRequest(
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
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return "The service could not be reached. Check your connection and try again.";
    }
    if (error.status === 401) return "Your session has expired. Sign in again.";
    if (error.status === 403) {
      return "You are not authorized to complete this request.";
    }
    if (error.status === 404) return "The requested resource is unavailable.";
  }
  return "The request could not be completed. Please try again.";
}

function setFormPending(form, pending, submitLabel, pendingLabel) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = pending;
  button.textContent = pending ? pendingLabel : submitLabel;
  form.setAttribute("aria-busy", String(pending));
}

function selectView(view) {
  const validViews = [
    "overview",
    "security",
    "profile",
    "workflows",
    ...Object.keys(resourceViews),
  ];
  const selected = !view
    ? "overview"
    : validViews.includes(view)
      ? view
      : "not-found";
  document.querySelector("#overview-view").hidden = selected !== "overview";
  document.querySelector("#security-view").hidden = selected !== "security";
  document.querySelector("#profile-view").hidden = selected !== "profile";
  document.querySelector("#workflows-view").hidden = selected !== "workflows";
  document.querySelector("#resource-view").hidden = !Object.hasOwn(
    resourceViews,
    selected,
  );
  document.querySelector("#not-found-view").hidden = selected !== "not-found";
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
  if (Object.hasOwn(resourceViews, selected)) {
    if (selected === "notifications") notificationOffset = 0;
    void loadResourceView(selected);
  }
}

function renderSession(session) {
  currentSession = session;
  hide(loadingView);
  hide(errorView);
  hide(authView);
  show(appView);
  userLabel.textContent = session.user.email;
  document.querySelector("#profile-details").replaceChildren();
  renderDefinitionList(document.querySelector("#profile-details"), [
    ["Name", session.user.displayName],
    ["Email", session.user.email],
    [
      "Session expires",
      formatDateTime(new Date(session.session.expiresAt), {
        locale: workflowLocale,
      }),
    ],
    ["Organizations available", session.memberships.length],
    ["Current organization", session.organization?.name],
    [
      "Current branch",
      session.availableBranches.find(
        (branch) => branch.branchId === session.branch?.branchId,
      )?.name ?? (session.branch ? "Selected branch" : "Organization-wide"),
    ],
  ]);

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
  void updateResourceNavigation(session);
  selectView(location.hash.slice(1));
}

async function refreshSession() {
  hide(authView);
  hide(errorView);
  hide(appView);
  hide(appError);
  hide(authMessage);
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
    authMessage.textContent =
      error instanceof ApiError && error.status === 401
        ? "Email or password is incorrect."
        : errorMessage(error);
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
    await authenticatedRequest("/auth/organization", {
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
    await authenticatedRequest("/auth/branch", {
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
    await authenticatedRequest("/auth/password/change", {
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
document.querySelector("#resource-refresh").addEventListener("click", () => {
  void loadResourceView(location.hash.slice(1));
});
window.addEventListener("hashchange", () => selectView(location.hash.slice(1)));
document.querySelectorAll(".oc-nav [data-view]").forEach((link) => {
  link.addEventListener("click", () => {
    sidebar.dataset.open = "false";
    menuToggle.setAttribute("aria-expanded", "false");
  });
});
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
