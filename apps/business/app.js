import { ApiError, createApiClient } from "../../packages/ui/src/api-client.js";
import {
  announce,
  createStatusBadge,
  setFieldError,
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
let dashboardLoadSequence = 0;
let workflowNavigationSequence = 0;
let resourceLoadSequence = 0;
let resourceNavigationSequence = 0;
const resourceOffsets = { notifications: 0, templates: 0, deliveries: 0 };
let preferenceLocale = workflowLocale;
const resourceViews = {
  organization: {
    title: "Organization",
    description:
      "Organization profile and regional configuration available in this context.",
    eyebrow: "Organization",
  },
  settings: {
    title: "Configuration",
    description:
      "Review organization settings and update supported regional preferences.",
    eyebrow: "Configuration",
  },
  notifications: {
    title: "Notifications",
    description: "Notifications delivered to your signed-in account.",
    eyebrow: "Your inbox",
  },
  preferences: {
    title: "Communication preferences",
    description:
      "Manage the notification channels and categories available to your account.",
    eyebrow: "Your account",
  },
  templates: {
    title: "Message templates",
    description:
      "Review template status and published versions. Message content is not displayed.",
    eyebrow: "Communications",
  },
  deliveries: {
    title: "Delivery activity",
    description:
      "Review delivery status for communications addressed to your account.",
    eyebrow: "Communications",
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
  features: {
    title: "Feature availability",
    description:
      "Effective feature values returned for the verified organization and branch context.",
    eyebrow: "Configuration",
  },
};
const boundaryViews = {
  branches: {
    title: "Branches",
    description:
      "Branches below are only the active branches authorized for your signed-in membership.",
    eyebrow: "Organization",
  },
  members: {
    title: "Users & members",
    description:
      "Membership administration is not available in this workspace.",
    eyebrow: "Organization",
  },
  audit: {
    title: "Audit & activity",
    description:
      "No authorized tenant audit-log read API is currently available to this application.",
    eyebrow: "Activity",
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

function statusVariant(status) {
  if (
    ["SUCCEEDED", "DELIVERED", "SENT", "PUBLISHED", "ACTIVE"].includes(status)
  ) {
    return "success";
  }
  if (["FAILED", "DEAD_LETTER", "CANCELLED", "INACTIVE"].includes(status)) {
    return "danger";
  }
  if (
    ["RETRYING", "PENDING", "RUNNING", "QUEUED", "SENDING"].includes(status)
  ) {
    return "warning";
  }
  return "neutral";
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
    const header = appendText(headerRow, "th", label);
    header.scope = "col";
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

function renderRoleCards(container, roles) {
  if (roles.length === 0) return false;
  for (const role of roles) {
    const card = document.createElement("article");
    card.className = "oc-card oc-stack";
    const heading = document.createElement("div");
    heading.className = "oc-cluster";
    appendText(heading, "h2", role.name, "oc-section-title");
    heading.append(
      createStatusBadge(
        role.status,
        role.status === "ACTIVE" ? "success" : "warning",
      ),
    );
    card.append(heading);
    appendText(
      card,
      "p",
      role.description || "No role description is available.",
      "oc-muted",
    );
    appendText(
      card,
      "p",
      role.isSystem ? "System role" : "Organization role",
      "oc-help",
    );
    const disclosure = document.createElement("details");
    disclosure.className = "oc-dropdown";
    const summary = document.createElement("summary");
    summary.textContent = "View permissions and data scopes";
    const grants = document.createElement("div");
    grants.className = "oc-stack";
    grants.setAttribute("aria-live", "polite");
    disclosure.append(summary, grants);
    disclosure.addEventListener("toggle", () => {
      if (!disclosure.open || disclosure.dataset.loaded === "true") return;
      disclosure.dataset.loaded = "true";
      grants.textContent = "Loading role grants…";
      void authenticatedRequest(`/roles/${encodeURIComponent(role.id)}`)
        .then((result) => {
          grants.replaceChildren();
          if (
            !Array.isArray(result.permissions) ||
            result.permissions.length === 0
          ) {
            appendText(grants, "p", "No permissions are assigned.", "oc-muted");
            return;
          }
          renderSimpleTable(
            grants,
            ["Permission", "Data scope"],
            result.permissions.map((permission) => [
              permission.key,
              permission.scopeType,
            ]),
          );
        })
        .catch((error) => {
          disclosure.dataset.loaded = "false";
          grants.textContent = errorMessage(error);
        });
    });
    card.append(disclosure);
    container.append(card);
  }
  return true;
}

function renderPreferences(container, result, organizationId) {
  preferenceLocale = resolveLocale(result.locale ?? workflowLocale);
  const localeField = document.createElement("div");
  localeField.className = "oc-field";
  const localeLabel = document.createElement("label");
  localeLabel.htmlFor = "preference-locale";
  localeLabel.textContent = "Preferred language";
  const localeSelect = document.createElement("select");
  localeSelect.id = "preference-locale";
  localeSelect.className = "oc-input";
  for (const [value, label] of [
    ["en", "English"],
    ["sw", "Kiswahili"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    localeSelect.append(option);
  }
  localeSelect.value = preferenceLocale.split("-")[0];
  localeSelect.addEventListener("change", async () => {
    setBusy(localeSelect, true);
    try {
      await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/notification-preferences`,
        { method: "PUT", body: { locale: localeSelect.value } },
      );
      preferenceLocale = resolveLocale(localeSelect.value);
      announce("Language preference updated.", "success");
    } catch (error) {
      announce(errorMessage(error), "error");
      localeSelect.value = preferenceLocale.split("-")[0];
    } finally {
      setBusy(localeSelect, false);
    }
  });
  localeField.append(localeLabel, localeSelect);
  container.append(localeField);

  const personalPreferences = Array.isArray(result.preferences)
    ? result.preferences
    : [];
  const defaults = Array.isArray(result.defaults) ? result.defaults : [];
  const preferenceMap = new Map();
  for (const preference of defaults) {
    preferenceMap.set(
      `${preference.channel}:${preference.category}`,
      preference,
    );
  }
  for (const preference of personalPreferences) {
    preferenceMap.set(
      `${preference.channel}:${preference.category}`,
      preference,
    );
  }
  const preferences = [...preferenceMap.values()];
  if (preferences.length === 0) {
    appendText(
      container,
      "p",
      "No per-channel notification preferences are configured for this account.",
      "oc-state oc-state--empty",
    );
    if (result.defaultsError) {
      appendText(
        container,
        "p",
        `Organization notification defaults could not be loaded. ${result.defaultsError}`,
        "oc-state oc-state--error",
      );
    }
    return true;
  }
  const table = document.createElement("div");
  table.className = "oc-table-wrap";
  const tableElement = document.createElement("table");
  tableElement.className = "oc-table";
  const header = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const title of ["Channel", "Category", "Enabled"]) {
    const header = appendText(headerRow, "th", title);
    header.scope = "col";
  }
  header.append(headerRow);
  const body = document.createElement("tbody");
  for (const preference of preferences) {
    const row = document.createElement("tr");
    appendText(row, "td", preference.channel);
    appendText(row, "td", preference.category);
    const cell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(preference.enabled);
    let previousValue = checkbox.checked;
    checkbox.setAttribute(
      "aria-label",
      `${preference.channel} ${preference.category} notifications`,
    );
    checkbox.addEventListener("change", async () => {
      setBusy(checkbox, true);
      try {
        await authenticatedRequest(
          `/organizations/${encodeURIComponent(organizationId)}/notification-preferences`,
          {
            method: "PUT",
            body: {
              channel: preference.channel,
              category: preference.category,
              enabled: checkbox.checked,
            },
          },
        );
        previousValue = checkbox.checked;
        announce("Notification preference updated.", "success");
      } catch (error) {
        checkbox.checked = previousValue;
        announce(errorMessage(error), "error");
      } finally {
        setBusy(checkbox, false);
      }
    });
    cell.append(checkbox);
    row.append(cell);
    body.append(row);
  }
  tableElement.append(header, body);
  table.append(tableElement);
  container.append(table);
  if (result.defaultsError) {
    appendText(
      container,
      "p",
      `Organization defaults could not be loaded. ${result.defaultsError}`,
      "oc-state oc-state--error",
    );
  }
  return true;
}

function renderRegionalSettingsForm(container, result, organizationId) {
  const form = document.createElement("form");
  form.className = "oc-card oc-stack";
  form.setAttribute("aria-label", "Update organization regional settings");
  appendText(form, "h2", "Regional settings", "oc-section-title");
  appendText(
    form,
    "p",
    "Saving requires the organization's settings permission. The API validates and authorizes every update.",
    "oc-help",
  );
  const current = result.settings ?? {};
  const fields = [
    {
      id: "organization-country",
      name: "countryCode",
      label: "Country code",
      value: current.countryCode ?? "",
      pattern: "[A-Z]{2}",
      placeholder: "KE",
    },
    {
      id: "organization-currency",
      name: "currencyCode",
      label: "Currency code",
      value: current.currencyCode ?? "",
      pattern: "[A-Z]{3}",
      placeholder: "KES",
    },
    {
      id: "organization-timezone",
      name: "timezone",
      label: "IANA time zone",
      value: current.timezone ?? "",
      placeholder: "Africa/Nairobi",
    },
  ];
  const grid = document.createElement("div");
  grid.className = "oc-form-grid";
  for (const field of fields) {
    const wrapper = document.createElement("div");
    wrapper.className = "oc-field";
    const label = document.createElement("label");
    label.htmlFor = field.id;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = field.id;
    input.className = "oc-input";
    input.name = field.name;
    input.value = field.value;
    input.required = true;
    input.maxLength = field.name === "timezone" ? 100 : 3;
    input.placeholder = field.placeholder;
    if (field.pattern) input.pattern = field.pattern;
    input.addEventListener("input", () => setFieldError(input, ""));
    wrapper.append(label, input);
    grid.append(wrapper);
  }
  const localeField = document.createElement("div");
  localeField.className = "oc-field";
  const localeLabel = document.createElement("label");
  localeLabel.htmlFor = "organization-locale";
  localeLabel.textContent = "Organization locale";
  const localeSelect = document.createElement("select");
  localeSelect.id = "organization-locale";
  localeSelect.className = "oc-input";
  localeSelect.name = "locale";
  for (const [value, label] of [
    ["en", "English"],
    ["sw", "Kiswahili"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    localeSelect.append(option);
  }
  localeSelect.value = resolveLocale(current.locale ?? "en").split("-")[0];
  localeField.append(localeLabel, localeSelect);
  grid.append(localeField);
  const businessField = document.createElement("div");
  businessField.className = "oc-field";
  const businessLabel = document.createElement("label");
  businessLabel.htmlFor = "organization-legal-name";
  businessLabel.textContent = "Legal name";
  const legalName = document.createElement("input");
  legalName.id = "organization-legal-name";
  legalName.className = "oc-input";
  legalName.name = "legalName";
  legalName.maxLength = 200;
  legalName.value = result.business?.legalName ?? "";
  businessField.append(businessLabel, legalName);
  grid.append(businessField);
  const error = document.createElement("p");
  error.className = "oc-alert oc-alert--error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "oc-button";
  save.textContent = "Save organization settings";
  form.append(grid, error, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hide(error);
    if (!form.reportValidity()) return;
    const currencyInput = form.elements.namedItem("currencyCode");
    const currencies =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("currency")
        : null;
    if (currencies && !currencies.includes(currencyInput.value)) {
      setFieldError(currencyInput, "Enter a supported ISO 4217 currency code.");
      currencyInput.focus();
      return;
    }
    const timezoneInput = form.elements.namedItem("timezone");
    try {
      new Intl.DateTimeFormat("en", {
        timeZone: timezoneInput.value,
      });
      setFieldError(timezoneInput, "");
    } catch {
      setFieldError(
        timezoneInput,
        "Enter a valid IANA time zone, such as Africa/Nairobi.",
      );
      timezoneInput.focus();
      return;
    }
    setBusy(save, true);
    try {
      const body = {
        countryCode: form.elements.namedItem("countryCode").value,
        currencyCode: form.elements.namedItem("currencyCode").value,
        timezone: form.elements.namedItem("timezone").value,
        locale: localeSelect.value,
      };
      const updatedLegalName = form.elements
        .namedItem("legalName")
        .value.trim();
      if (updatedLegalName !== (result.business?.legalName ?? "")) {
        body.legalName = updatedLegalName || null;
      }
      await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/configuration`,
        { method: "PATCH", body },
      );
      announce("Organization settings saved.", "success");
      await loadResourceView("organization");
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      show(error);
    } finally {
      setBusy(save, false);
    }
  });
  container.append(form);
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
  if (view === "organization" || view === "settings") {
    const { organization, settings, business, capabilities } = result;
    appendText(container, "h2", "Organization profile", "oc-section-title");
    renderDefinitionList(container, [
      ["Organization", organization?.name],
      ["Industry", organization?.industry],
      ["Deployment type", organization?.deploymentType],
      ["Access context", "Verified active membership"],
      [
        "Current branch",
        currentSession?.availableBranches.find(
          (branch) => branch.branchId === currentSession.branch?.branchId,
        )?.name ?? "Organization-wide",
      ],
    ]);
    appendText(container, "h2", "Business information", "oc-section-title");
    renderDefinitionList(container, [
      ["Legal name", business?.legalName],
      ["Registration number", business?.registrationNumber],
      ["Tax number", business?.taxNumber],
      ["Business type", business?.businessType],
    ]);
    if (view === "organization") {
      appendText(
        container,
        "p",
        "Organization lifecycle status and full profile management are not exposed by the current organization-scoped APIs.",
        "oc-help",
      );
      return true;
    }
    appendText(container, "h2", "Regional preferences", "oc-section-title");
    renderDefinitionList(container, [
      ["Country", settings?.countryCode],
      ["Currency", settings?.currencyCode],
      ["Time zone", settings?.timezone],
      ["Locale", settings?.locale],
    ]);
    appendText(container, "h2", "Available configuration", "oc-section-title");
    renderDefinitionList(
      container,
      Object.entries(capabilities ?? {}).map(([key, value]) => [
        key,
        value ? "Available" : "Not available",
      ]),
    );
    renderRegionalSettingsForm(container, result, organizationId);
    return true;
  }
  if (view === "modules") {
    const entitlements = new Map(
      (result.entitlements ?? []).map((item) => [item.moduleName, item]),
    );
    const modules = result.catalog ?? [];
    renderSimpleTable(
      container,
      [
        "Module",
        "Registry state",
        "Organization entitlement",
        "Frontend boundary",
      ],
      modules.map((item) => [
        item.displayName,
        item.available && item.lifecycle === "AVAILABLE"
          ? `${item.lifecycle} · available`
          : `${item.lifecycle} · unavailable`,
        entitlements.get(item.name)?.status ??
          item.entitlementStatus ??
          "Not enabled",
        item.name === "core.configuration"
          ? "Platform foundation views"
          : "Business UI not implemented",
      ]),
    );
    return modules.length > 0;
  }
  if (view === "roles") {
    const roles = result.roles ?? [];
    const permissions = result.permissions ?? [];
    if (roles.length > 0) {
      appendText(container, "h2", "Organization roles", "oc-section-title");
      renderRoleCards(container, roles);
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
    if (result.rolesError || result.permissionsError) {
      appendText(
        container,
        "p",
        "Some access information could not be loaded. " +
          [result.rolesError, result.permissionsError]
            .filter(Boolean)
            .join(" "),
        "oc-state oc-state--error",
      );
    }
    return (
      roles.length + permissions.length > 0 ||
      Boolean(result.rolesError || result.permissionsError)
    );
  }
  if (view === "preferences") {
    return renderPreferences(container, result, organizationId);
  }
  if (view === "templates") {
    const templates = Array.isArray(result.templates) ? result.templates : [];
    for (const template of templates) {
      const card = document.createElement("article");
      card.className = "oc-card oc-stack";
      const heading = document.createElement("div");
      heading.className = "oc-cluster";
      appendText(heading, "h2", template.key, "oc-section-title");
      heading.append(
        createStatusBadge(
          template.status,
          template.status === "PUBLISHED" ? "success" : "neutral",
        ),
      );
      card.append(heading);
      appendText(card, "p", `Channel: ${template.channel}`, "oc-muted");
      const versions = Array.isArray(template.versions)
        ? template.versions
        : [];
      if (versions.length) {
        renderSimpleTable(
          card,
          ["Version", "Locale", "Status", "Published"],
          versions.map((version) => [
            version.version,
            version.locale,
            version.status,
            version.publishedAt
              ? formatDateTime(new Date(version.publishedAt), {
                  locale: preferenceLocale,
                })
              : "Not published",
          ]),
        );
      } else {
        appendText(
          card,
          "p",
          "No template versions are available.",
          "oc-muted",
        );
      }
      container.append(card);
    }
    return templates.length > 0;
  }
  if (view === "deliveries") {
    const deliveries = Array.isArray(result.deliveries)
      ? result.deliveries
      : [];
    if (!deliveries.length) return false;
    renderSimpleTable(
      container,
      ["Created", "Channel", "Category", "Status", "Attempts", "Result"],
      deliveries.map((delivery) => [
        formatDateTime(new Date(delivery.createdAt), {
          locale: preferenceLocale,
        }),
        delivery.channel,
        delivery.category,
        delivery.status,
        `${delivery.attemptCount} / ${delivery.maxAttempts}`,
        delivery.lastFailureClass ?? delivery.lastFailureCode ?? "—",
      ]),
    );
    appendText(
      container,
      "p",
      "Delivery content, recipient details, provider credentials, and internal payloads are not displayed.",
      "oc-help",
    );
    return true;
  }
  if (view === "features") {
    const features = Array.isArray(result.features) ? result.features : [];
    if (!features.length) return false;
    renderSimpleTable(
      container,
      ["Feature", "Effective state", "Description"],
      features.map((feature) => [
        feature.name,
        typeof feature.enabled === "boolean"
          ? feature.enabled
            ? "Enabled"
            : "Disabled"
          : typeof feature.value === "boolean"
            ? feature.value
              ? "Enabled"
              : "Disabled"
            : "Configured",
        feature.description,
      ]),
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
        `/organizations/${encodeURIComponent(organizationId)}/notifications?limit=20&offset=${resourceOffsets.notifications}`,
      );
    } else if (view === "organization" || view === "settings") {
      result = await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/configuration`,
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
        rolesError:
          rolesResult.status === "rejected"
            ? errorMessage(rolesResult.reason)
            : null,
        permissionsError:
          permissionsResult.status === "rejected"
            ? errorMessage(permissionsResult.reason)
            : null,
      };
      if (
        rolesResult.status === "rejected" &&
        permissionsResult.status === "rejected"
      ) {
        throw rolesResult.reason;
      }
    } else if (view === "preferences") {
      const [personal, defaults] = await Promise.allSettled([
        authenticatedRequest(
          `/organizations/${encodeURIComponent(organizationId)}/notification-preferences`,
        ),
        authenticatedRequest(
          `/organizations/${encodeURIComponent(organizationId)}/notification-preferences/defaults`,
        ),
      ]);
      if (personal.status === "rejected") throw personal.reason;
      result = {
        ...personal.value,
        defaults:
          defaults.status === "fulfilled" ? defaults.value.preferences : [],
        defaultsError:
          defaults.status === "rejected" ? errorMessage(defaults.reason) : null,
      };
    } else if (view === "templates") {
      result = await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/communication-templates?limit=20&offset=${resourceOffsets.templates}`,
      );
    } else if (view === "deliveries") {
      result = await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/communications/deliveries?limit=20&offset=${resourceOffsets.deliveries}`,
      );
    } else if (view === "features") {
      result = await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/features`,
      );
    } else {
      throw new TypeError(`Unsupported resource view: ${view}`);
    }
    if (sequence !== resourceLoadSequence || currentSession !== session) return;
    const hasContent = renderResource(view, result, content);
    if (!hasContent) {
      empty.textContent =
        resourceOffsets[view] > 0
          ? "There are no more results."
          : view === "notifications"
            ? "You do not have any notifications yet."
            : "No information is available in this organization context.";
      show(empty);
    }
    if (["notifications", "templates", "deliveries"].includes(view)) {
      const key =
        view === "notifications"
          ? "notifications"
          : view === "templates"
            ? "templates"
            : "deliveries";
      const values =
        view === "notifications"
          ? result.notifications
          : view === "templates"
            ? result.templates
            : result.deliveries;
      renderResourcePagination(view, key, values ?? []);
    }
  } catch (requestError) {
    if (sequence !== resourceLoadSequence) return;
    error.textContent = errorMessage(requestError);
    show(error);
  } finally {
    if (sequence === resourceLoadSequence) hide(loading);
  }
}

function loadBoundaryView(view) {
  const metadata = boundaryViews[view];
  if (!metadata) return;
  document.querySelector("#boundary-eyebrow").textContent = metadata.eyebrow;
  document.querySelector("#boundary-title").textContent = metadata.title;
  document.querySelector("#boundary-description").textContent =
    metadata.description;
  const content = document.querySelector("#boundary-content");
  content.replaceChildren();
  if (view === "branches") {
    const branches = currentSession?.availableBranches ?? [];
    if (branches.length === 0) {
      appendText(
        content,
        "p",
        "No active branches are available to your current organization membership.",
        "oc-state oc-state--empty",
      );
      return;
    }
    renderSimpleTable(
      content,
      ["Branch", "Code", "Context"],
      branches.map((branch) => [
        branch.name,
        branch.code || "—",
        branch.branchId === currentSession.branch?.branchId
          ? "Selected"
          : "Available for selection",
      ]),
    );
    appendText(
      content,
      "p",
      "Branch choices come only from the authenticated session response. Use the verified branch selector above to switch context.",
      "oc-help",
    );
    return;
  }
  if (view === "members") {
    const memberships = currentSession?.memberships ?? [];
    appendText(
      content,
      "div",
      "The session API returns only your own active organization memberships. A tenant member directory, membership status details, and role assignment UI are not exposed by a list API.",
      "oc-state oc-state--empty",
    );
    if (memberships.length) {
      renderSimpleTable(
        content,
        ["Your organization access"],
        memberships.map((membership) => [membership.name]),
      );
    }
    return;
  }
  appendText(
    content,
    "div",
    "Audit records are written by the platform, but there is no tenant-authorized audit read API available to this workspace. No activity is fabricated or inferred from unrelated data.",
    "oc-state oc-state--empty",
  );
}

function renderDashboardStatus(container, text, state = "empty") {
  container.replaceChildren();
  const stateElement = document.createElement("p");
  stateElement.className = `oc-state oc-state--${state}`;
  stateElement.setAttribute("role", state === "error" ? "alert" : "status");
  stateElement.textContent = text;
  container.append(stateElement);
}

async function loadDashboard(session) {
  const sequence = ++dashboardLoadSequence;
  const organizationId = session.organization?.organizationId;
  const modules = document.querySelector("#dashboard-modules");
  const notifications = document.querySelector("#dashboard-notifications");
  const workflows = document.querySelector("#dashboard-workflows");
  const organization = document.querySelector("#dashboard-organization");
  organization.replaceChildren();
  renderDefinitionList(organization, [
    ["Organization", session.organization?.name],
    ["Organization access", session.organization ? "Verified" : "Not selected"],
    [
      "Branch context",
      session.availableBranches.find(
        (branch) => branch.branchId === session.branch?.branchId,
      )?.name ?? (session.branch ? "Selected branch" : "Organization-wide"),
    ],
    [
      "Session expires",
      formatDateTime(new Date(session.session.expiresAt), {
        locale: preferenceLocale,
      }),
    ],
  ]);
  if (!organizationId) {
    renderDashboardStatus(
      modules,
      "Select an organization to view modules and entitlements.",
    );
    renderDashboardStatus(
      notifications,
      "Select an organization to view notifications.",
    );
    renderDashboardStatus(
      workflows,
      "Select an organization to view workflow activity.",
    );
    return;
  }
  renderDashboardStatus(modules, "Loading organization modules…", "loading");
  renderDashboardStatus(
    notifications,
    "Loading recent notifications…",
    "loading",
  );
  renderDashboardStatus(workflows, "Loading workflow activity…", "loading");
  const [moduleResult, notificationResult, workflowResult] =
    await Promise.allSettled([
      Promise.all([
        authenticatedRequest("/modules"),
        authenticatedRequest(
          `/organizations/${encodeURIComponent(organizationId)}/modules`,
        ),
      ]),
      authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/notifications?limit=3`,
      ),
      authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/workflow-executions?limit=3`,
      ),
    ]);
  if (sequence !== dashboardLoadSequence || currentSession !== session) return;

  if (moduleResult.status === "fulfilled") {
    const [catalog, entitlementsResult] = moduleResult.value;
    const entitlements = new Map(
      (entitlementsResult.entitlements ?? []).map((item) => [
        item.moduleName,
        item.status,
      ]),
    );
    const rows = catalog.catalog ?? [];
    modules.replaceChildren();
    if (!rows.length) {
      renderDashboardStatus(modules, "No modules are registered.");
    } else {
      renderSimpleTable(
        modules,
        ["Module", "Availability", "Organization status"],
        rows
          .slice(0, 5)
          .map((item) => [
            item.displayName,
            item.available && item.lifecycle === "AVAILABLE"
              ? "Available"
              : "Unavailable",
            entitlements.get(item.name) ??
              item.entitlementStatus ??
              "Not enabled",
          ]),
      );
      appendText(
        modules,
        "p",
        "Module registry availability does not mean a business module UI is included. Unimplemented business modules remain unavailable in this frontend.",
        "oc-help",
      );
    }
  } else {
    renderDashboardStatus(modules, errorMessage(moduleResult.reason), "error");
  }

  if (notificationResult.status === "fulfilled") {
    const rows = notificationResult.value.notifications ?? [];
    notifications.replaceChildren();
    if (!rows.length) {
      renderDashboardStatus(notifications, "No recent notifications.");
    } else {
      for (const item of rows) {
        const line = document.createElement("div");
        line.className = "oc-cluster";
        appendText(line, "span", item.title);
        line.append(
          createStatusBadge(
            item.readAt ? "Read" : "Unread",
            item.readAt ? "neutral" : "info",
          ),
        );
        notifications.append(line);
      }
    }
  } else {
    renderDashboardStatus(
      notifications,
      errorMessage(notificationResult.reason),
      "error",
    );
  }

  if (workflowResult.status === "fulfilled") {
    const rows = workflowResult.value.executions ?? [];
    workflows.replaceChildren();
    if (!rows.length) {
      renderDashboardStatus(workflows, "No recent workflow executions.");
    } else {
      renderSimpleTable(
        workflows,
        ["Workflow", "Status", "Started"],
        rows.map((item) => [
          item.workflowName,
          item.status,
          formatDateTime(new Date(item.startedAt), {
            locale: preferenceLocale,
          }),
        ]),
      );
    }
  } else {
    renderDashboardStatus(
      workflows,
      errorMessage(workflowResult.reason),
      "error",
    );
  }
}

function renderResourcePagination(view, key, rows) {
  const content = document.querySelector("#resource-content");
  const pagination = document.createElement("nav");
  pagination.className = "oc-pagination";
  pagination.setAttribute("aria-label", `${resourceViews[view].title} pages`);
  const controls = document.createElement("div");
  controls.className = "oc-pagination__controls";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "oc-button oc-button--secondary";
  previous.textContent = "Previous";
  previous.disabled = resourceOffsets[key] === 0;
  previous.addEventListener("click", () => {
    resourceOffsets[key] = Math.max(0, resourceOffsets[key] - 20);
    void loadResourceView(view);
  });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "oc-button oc-button--secondary";
  next.textContent = "Next";
  next.disabled = rows.length < 20;
  next.addEventListener("click", () => {
    resourceOffsets[key] += 20;
    void loadResourceView(view);
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
    [
      "organization-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/configuration`,
    ],
    [
      "preferences-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/notification-preferences`,
    ],
    [
      "templates-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/communication-templates?limit=1`,
    ],
    [
      "deliveries-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/communications/deliveries?limit=1`,
    ],
    [
      "features-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/features`,
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
    const header = document.createElement("div");
    header.className = "oc-cluster";
    header.append(
      heading,
      createStatusBadge(
        workflowStatusLabel(execution.status),
        statusVariant(execution.status),
      ),
    );
    card.append(header);
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
        item.append(
          document.createTextNode(`${actionName} — `),
          createStatusBadge(
            workflowStatusLabel(action.status),
            statusVariant(action.status),
          ),
        );
        if (action.failureCode) {
          item.append(
            document.createTextNode(
              ` (${workflowText("workflow.failure")}: ${action.failureCode})`,
            ),
          );
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
      requestError instanceof ApiError && requestError.status === 403
        ? workflowText("workflow.accessDenied")
        : errorMessage(requestError);
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
    if (error.status === 400) {
      return "Some entered values are invalid. Review them and try again.";
    }
    if (error.status === 409) {
      return "This change conflicts with current settings. Refresh and try again.";
    }
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
    ...Object.keys(boundaryViews),
  ];
  const selected = !view
    ? "overview"
    : validViews.includes(view)
      ? view
      : "not-found";
  const pageTitle =
    resourceViews[selected]?.title ??
    boundaryViews[selected]?.title ??
    (selected === "overview" ? "Dashboard" : "OneCore workspace");
  document.title = `${pageTitle} · OneCore`;
  document.querySelector("#overview-view").hidden = selected !== "overview";
  document.querySelector("#security-view").hidden = selected !== "security";
  document.querySelector("#profile-view").hidden = selected !== "profile";
  document.querySelector("#workflows-view").hidden = selected !== "workflows";
  document.querySelector("#boundary-view").hidden = !Object.hasOwn(
    boundaryViews,
    selected,
  );
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
  const currentLink = [
    ...document.querySelectorAll(".oc-nav [data-view]"),
  ].find((link) => link.dataset.view === selected);
  const breadcrumb = document.querySelector("#breadcrumbs");
  breadcrumb.replaceChildren();
  const crumb = document.createElement("li");
  crumb.textContent =
    currentLink?.textContent?.trim() ??
    (selected === "overview" ? "Dashboard" : "Page");
  crumb.setAttribute("aria-current", "page");
  breadcrumb.append(crumb);
  if (selected === "workflows") void loadWorkflowExecutions();
  if (Object.hasOwn(boundaryViews, selected)) loadBoundaryView(selected);
  if (Object.hasOwn(resourceViews, selected)) {
    if (Object.hasOwn(resourceOffsets, selected)) {
      resourceOffsets[selected] = 0;
    }
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
  updateWorkflowNavigation(session);
  void updateResourceNavigation(session);
  void loadDashboard(session);
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
      currentSession = undefined;
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
      currentSession?.organization?.organizationId ?? "";
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
    branchSelect.value = currentSession?.branch?.branchId ?? "";
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
    await authenticatedRequest("/auth/logout", { method: "POST", body: {} });
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
