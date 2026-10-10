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
const globalSearchForm = document.querySelector("#global-search-form");
const globalSearchInput = document.querySelector("#global-search");
const globalSearchDialog = document.querySelector("#global-search-dialog");
const sidebar = document.querySelector("#app-sidebar");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
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
const branchMessages = {
  en: {
    "branches.nav": "Branches",
    "branches.eyebrow": "Organization",
    "branches.title": "Branches",
    "branches.description":
      "Manage branch names, codes, addresses, and active status.",
    "branches.loading": "Loading branches…",
    "branches.empty": "No branches are available for this organization.",
    "branches.noMore": "There are no more branches.",
    "branches.loadFailed": "Branches could not be loaded. Please try again.",
    "branches.create": "Create branch",
    "branches.createTitle": "New branch",
    "branches.name": "Name",
    "branches.code": "Code",
    "branches.address": "Address (optional)",
    "branches.status": "Status",
    "branches.actions": "Actions",
    "branches.active": "Active",
    "branches.inactive": "Inactive",
    "branches.suspended": "Suspended",
    "branches.closed": "Closed",
    "branches.edit": "Edit",
    "branches.save": "Save changes",
    "branches.cancel": "Cancel",
    "branches.deactivate": "Deactivate",
    "branches.reactivate": "Reactivate",
    "branches.previous": "Previous",
    "branches.next": "Next",
    "branches.pageLabel": "Branch pages",
    "branches.showing": "Showing {shown} of {total}",
    "branches.created": "Branch created.",
    "branches.updated": "Branch updated.",
    "branches.deactivated": "Branch deactivated.",
    "branches.reactivated": "Branch reactivated.",
    "branches.confirmDeactivate": "Deactivate {name}?",
    "branches.accessDenied": "You are not authorized to manage branches.",
    "branches.error.network":
      "The service could not be reached. Check your connection and try again.",
    "branches.error.session": "Your session has expired. Sign in again.",
    "branches.error.forbidden":
      "You are not authorized to complete this request.",
    "branches.error.invalid":
      "Some entered values are invalid. Review them and try again.",
    "branches.error.conflict":
      "A branch with that code already exists. Refresh and try again.",
    "branches.error.generic":
      "The request could not be completed. Please try again.",
    "branches.retry": "Retry",
  },
  sw: {
    "branches.nav": "Matawi",
    "branches.eyebrow": "Shirika",
    "branches.title": "Matawi",
    "branches.description":
      "Dhibiti majina, misimbo, anwani na hali ya matawi.",
    "branches.loading": "Inapakia matawi…",
    "branches.empty": "Hakuna matawi yanayopatikana kwa shirika hili.",
    "branches.noMore": "Hakuna matawi mengine.",
    "branches.loadFailed":
      "Imeshindikana kupakia matawi. Tafadhali jaribu tena.",
    "branches.create": "Unda tawi",
    "branches.createTitle": "Tawi jipya",
    "branches.name": "Jina",
    "branches.code": "Msimbo",
    "branches.address": "Anwani (si lazima)",
    "branches.status": "Hali",
    "branches.actions": "Vitendo",
    "branches.active": "Linafanya kazi",
    "branches.inactive": "Limesitishwa",
    "branches.suspended": "Limesimamishwa",
    "branches.closed": "Limefungwa",
    "branches.edit": "Hariri",
    "branches.save": "Hifadhi mabadiliko",
    "branches.cancel": "Ghairi",
    "branches.deactivate": "Sitisha",
    "branches.reactivate": "Washa tena",
    "branches.previous": "Iliyotangulia",
    "branches.next": "Inayofuata",
    "branches.pageLabel": "Kurasa za matawi",
    "branches.showing": "Inaonyesha {shown} kati ya {total}",
    "branches.created": "Tawi limeundwa.",
    "branches.updated": "Tawi limesasishwa.",
    "branches.deactivated": "Tawi limesitishwa.",
    "branches.reactivated": "Tawi limewashwa tena.",
    "branches.confirmDeactivate": "Sitisha {name}?",
    "branches.accessDenied": "Huna ruhusa ya kudhibiti matawi.",
    "branches.error.network":
      "Huduma haipatikani. Angalia muunganisho wako kisha ujaribu tena.",
    "branches.error.session": "Kipindi chako kimeisha. Ingia tena.",
    "branches.error.forbidden": "Huna ruhusa ya kutekeleza ombi hili.",
    "branches.error.invalid":
      "Baadhi ya thamani si sahihi. Zikague kisha ujaribu tena.",
    "branches.error.conflict":
      "Tawi lenye msimbo huo tayari lipo. Onyesha upya kisha ujaribu tena.",
    "branches.error.generic": "Ombi halikukamilika. Tafadhali jaribu tena.",
    "branches.retry": "Jaribu tena",
  },
};
let currentTheme = 0;
let currentSession;
let workflowLoadSequence = 0;
let branchLoadSequence = 0;
let branchOffset = 0;
let dashboardLoadSequence = 0;
let workflowNavigationSequence = 0;
let globalSearchSequence = 0;
let resourceLoadSequence = 0;
let resourceNavigationSequence = 0;
let businessResourceSequence = 0;
let businessResourceContext = "";
const businessResourceOffsets = { customers: 0, products: 0 };
const businessResourceFilters = { customers: {}, products: {} };
const resourceOffsets = { notifications: 0, templates: 0, deliveries: 0 };
let preferenceLocale = workflowLocale;
const resourceViews = {
  organization: {
    title: "Business profile",
    description:
      "Review business identity and configuration returned for your verified organization.",
    eyebrow: "Business Manager",
  },
  settings: {
    title: "Business Manager settings",
    description:
      "Review organization settings and update supported regional preferences.",
    eyebrow: "Business Manager",
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
  customers: {
    title: "Customers",
    description:
      "Manage organization customers and contacts using tenant-authorized records.",
    eyebrow: "Business Manager",
  },
  products: {
    title: "Products & services",
    description:
      "Maintain reusable product and service master data for authorized organization branches.",
    eyebrow: "Business Manager catalog",
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

function branchText(key, values = {}) {
  return translate(key, {
    locale: preferenceLocale,
    messages: branchMessages,
    fallbackText: key,
  }).replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

function setBranchesNavigationText() {
  document.querySelector("#branches-nav-label").textContent =
    branchText("branches.nav");
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
  document.querySelector("#workflow-nav-label").textContent =
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
  document.querySelector("#dashboard-workflows-link").hidden = true;
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
        document.querySelector("#dashboard-workflows-link").hidden = false;
      }
    })
    .catch(() => {
      if (
        sequence === workflowNavigationSequence &&
        currentSession === session
      ) {
        navigation.hidden = true;
        document.querySelector("#dashboard-workflows-link").hidden = true;
      }
    });
}

function sessionExpired() {
  currentSession = undefined;
  businessResourceSequence += 1;
  businessResourceContext = "";
  businessResourceOffsets.customers = 0;
  businessResourceOffsets.products = 0;
  businessResourceFilters.customers = {};
  businessResourceFilters.products = {};
  document.querySelector("#boundary-content").replaceChildren();
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
  setBranchesNavigationText();
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
      setBranchesNavigationText();
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
  for (const field of [
    {
      id: "organization-registration-number",
      name: "registrationNumber",
      label: "Business registration number",
      value: result.business?.registrationNumber ?? "",
    },
    {
      id: "organization-tax-number",
      name: "taxNumber",
      label: "Business tax number",
      value: result.business?.taxNumber ?? "",
    },
  ]) {
    const wrapper = document.createElement("div");
    wrapper.className = "oc-field";
    const label = document.createElement("label");
    label.htmlFor = field.id;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = field.id;
    input.className = "oc-input";
    input.name = field.name;
    input.maxLength = 100;
    input.value = field.value;
    input.addEventListener("input", () => setFieldError(input, ""));
    wrapper.append(label, input);
    grid.append(wrapper);
  }
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
      for (const name of ["registrationNumber", "taxNumber"]) {
        const value = form.elements.namedItem(name).value.trim();
        if (value !== (result.business?.[name] ?? "")) {
          body[name] = value || null;
        }
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
    appendText(container, "h2", "Business profile", "oc-section-title");
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
      appendText(container, "h2", "Regional configuration", "oc-section-title");
      renderDefinitionList(container, [
        ["Country", settings?.countryCode],
        ["Currency", settings?.currencyCode],
        ["Time zone", settings?.timezone],
        ["Locale", settings?.locale],
      ]);
      appendText(
        container,
        "p",
        "The available API does not expose organization lifecycle status, a separate display name, or a stable address/contact profile contract. Those fields are not inferred or fabricated here.",
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
  if (view === "customers" || view === "products") {
    void loadBusinessManagerView(view);
    return;
  }
  if (view === "branches") {
    void loadBranchesView();
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

function branchRequestError(error) {
  if (error instanceof ApiError) {
    if (error.status === 0) return branchText("branches.error.network");
    if (error.status === 401) return branchText("branches.error.session");
    if (error.status === 403) return branchText("branches.error.forbidden");
    if (error.status === 400) return branchText("branches.error.invalid");
    if (error.status === 409) return branchText("branches.error.conflict");
  }
  return branchText("branches.error.generic");
}

function appendBranchError(container, error, retry) {
  const alert = appendText(
    container,
    "div",
    branchRequestError(error),
    "oc-alert oc-alert--error",
  );
  alert.setAttribute("role", "alert");
  const button = document.createElement("button");
  button.className = "oc-button oc-button--secondary";
  button.type = "button";
  button.textContent = branchText("branches.retry");
  button.addEventListener("click", retry);
  container.append(button);
}

function branchFormField(form, name, value = "", required = false) {
  const field = document.createElement("div");
  field.className = "oc-field";
  const id = `branch-${name}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = branchText(`branches.${name}`);
  const input = document.createElement("input");
  input.id = id;
  input.className = "oc-input";
  input.name = name;
  input.maxLength = name === "address" ? 1000 : name === "code" ? 50 : 200;
  input.required = required;
  input.value = value ?? "";
  field.append(label, input);
  form.append(field);
  return input;
}

function renderBranchCreateForm(container) {
  const form = document.createElement("form");
  form.className = "oc-card oc-grid";
  form.setAttribute("aria-label", branchText("branches.create"));
  appendText(
    form,
    "h2",
    branchText("branches.createTitle"),
    "oc-section-title",
  );
  branchFormField(form, "name", "", true);
  branchFormField(form, "code", "", true);
  branchFormField(form, "address");
  const error = appendText(form, "p", "", "oc-alert oc-alert--error");
  error.setAttribute("role", "alert");
  hide(error);
  const submit = document.createElement("button");
  submit.className = "oc-button";
  submit.type = "submit";
  submit.textContent = branchText("branches.create");
  form.append(submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hide(error);
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    values.name = values.name.trim();
    values.code = values.code.trim();
    values.address = values.address.trim() || null;
    setBusy(submit, true);
    try {
      await authenticatedRequest(branchesEndpoint(), {
        method: "POST",
        body: values,
      });
      branchOffset = 0;
      announce(branchText("branches.created"), "success");
      await loadBranchesView();
    } catch (requestError) {
      error.textContent = branchRequestError(requestError);
      show(error);
    } finally {
      setBusy(submit, false);
    }
  });
  container.append(form);
}

function branchesEndpoint() {
  const organizationId = currentSession?.organization?.organizationId;
  return organizationId
    ? `/organizations/${encodeURIComponent(organizationId)}/branches`
    : null;
}

function createInlineBranchInput(value, label, required = false) {
  const input = document.createElement("input");
  input.className = "oc-input";
  input.value = value ?? "";
  input.maxLength = label === "address" ? 1000 : label === "code" ? 50 : 200;
  input.required = required;
  input.setAttribute("aria-label", branchText(`branches.${label}`));
  return input;
}

function renderBranchTable(container, items, canUpdate) {
  const wrapper = document.createElement("div");
  wrapper.className = "oc-table-wrap";
  const table = document.createElement("table");
  table.className = "oc-table";
  const headings = [
    "branches.name",
    "branches.code",
    "branches.status",
    "branches.address",
    "branches.actions",
  ];
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const key of headings) {
    const cell = appendText(headerRow, "th", branchText(key));
    cell.scope = "col";
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  for (const branch of items) {
    const row = document.createElement("tr");
    for (const value of [
      branch.name,
      branch.code,
      branch.status,
      branch.address || "—",
    ]) {
      const cell = document.createElement("td");
      if (value === branch.status) {
        const statusKey = `branches.${String(value).toLowerCase()}`;
        cell.append(
          createStatusBadge(
            branchText(statusKey),
            statusVariant(String(value)),
          ),
        );
      } else {
        cell.textContent = String(value ?? "—");
      }
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.className = "oc-cluster";
    if (canUpdate) {
      const edit = document.createElement("button");
      edit.className = "oc-button oc-button--quiet";
      edit.type = "button";
      edit.textContent = branchText("branches.edit");
      edit.setAttribute(
        "aria-label",
        `${branchText("branches.edit")} ${branch.name}`,
      );
      edit.addEventListener("click", () => {
        row.replaceChildren();
        const nameCell = document.createElement("td");
        const codeCell = document.createElement("td");
        const statusCell = document.createElement("td");
        const addressCell = document.createElement("td");
        const actionCell = document.createElement("td");
        const name = createInlineBranchInput(branch.name, "name", true);
        const code = createInlineBranchInput(branch.code, "code", true);
        const address = createInlineBranchInput(branch.address, "address");
        nameCell.append(name);
        codeCell.append(code);
        statusCell.append(
          createStatusBadge(
            branchText(`branches.${branch.status.toLowerCase()}`),
            statusVariant(branch.status),
          ),
        );
        addressCell.append(address);
        const save = document.createElement("button");
        save.className = "oc-button oc-button--quiet";
        save.type = "button";
        save.textContent = branchText("branches.save");
        save.addEventListener("click", async () => {
          if (!name.reportValidity() || !code.reportValidity()) return;
          save.disabled = true;
          try {
            await authenticatedRequest(
              `${branchesEndpoint()}/${encodeURIComponent(branch.id)}`,
              {
                method: "PATCH",
                body: {
                  name: name.value.trim(),
                  code: code.value.trim(),
                  address: address.value.trim() || null,
                },
              },
            );
            announce(branchText("branches.updated"), "success");
            await loadBranchesView();
          } catch (requestError) {
            appendBranchError(container, requestError, loadBranchesView);
          } finally {
            save.disabled = false;
          }
        });
        const cancel = document.createElement("button");
        cancel.className = "oc-button oc-button--secondary";
        cancel.type = "button";
        cancel.textContent = branchText("branches.cancel");
        cancel.addEventListener("click", () => void loadBranchesView());
        actionCell.append(save, cancel);
        row.append(nameCell, codeCell, statusCell, addressCell, actionCell);
        name.focus();
      });
      actions.append(edit);

      if (["ACTIVE", "INACTIVE"].includes(branch.status)) {
        const activate = branch.status === "INACTIVE";
        const statusButton = document.createElement("button");
        statusButton.className = "oc-button oc-button--quiet";
        statusButton.type = "button";
        statusButton.textContent = branchText(
          activate ? "branches.reactivate" : "branches.deactivate",
        );
        statusButton.addEventListener("click", async () => {
          if (
            !activate &&
            !window.confirm(
              branchText("branches.confirmDeactivate", {
                name: branch.name,
              }),
            )
          ) {
            return;
          }
          statusButton.disabled = true;
          try {
            await authenticatedRequest(
              `${branchesEndpoint()}/${encodeURIComponent(branch.id)}`,
              {
                method: "PATCH",
                body: { status: activate ? "ACTIVE" : "INACTIVE" },
              },
            );
            announce(
              branchText(
                activate ? "branches.reactivated" : "branches.deactivated",
              ),
              "success",
            );
            await loadBranchesView();
          } catch (requestError) {
            appendBranchError(container, requestError, loadBranchesView);
          } finally {
            statusButton.disabled = false;
          }
        });
        actions.append(statusButton);
      }
    }
    row.append(actions);
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  container.append(wrapper);
}

async function loadBranchesView() {
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  const sequence = ++branchLoadSequence;
  const content = document.querySelector("#boundary-content");
  document.querySelector("#boundary-eyebrow").textContent =
    branchText("branches.eyebrow");
  document.querySelector("#boundary-title").textContent =
    branchText("branches.title");
  document.querySelector("#boundary-description").textContent = branchText(
    "branches.description",
  );
  setBranchesNavigationText();
  content.replaceChildren();
  if (!organizationId) {
    appendText(
      content,
      "p",
      branchText("branches.accessDenied"),
      "oc-state oc-state--empty",
    );
    return;
  }
  const loading = appendText(
    content,
    "p",
    branchText("branches.loading"),
    "oc-state oc-state--loading",
  );
  loading.setAttribute("role", "status");
  try {
    const params = new globalThis.URLSearchParams({
      limit: "20",
      offset: String(branchOffset),
    });
    const result = await authenticatedRequest(
      `${branchesEndpoint()}?${params}`,
    );
    if (sequence !== branchLoadSequence || currentSession !== session) return;
    content.replaceChildren();
    const capabilities = result.capabilities ?? {};
    if (capabilities.create === true) renderBranchCreateForm(content);
    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length) {
      renderBranchTable(content, items, capabilities.update === true);
    } else {
      appendText(
        content,
        "p",
        branchOffset > 0
          ? branchText("branches.noMore")
          : branchText("branches.empty"),
        "oc-state oc-state--empty",
      ).setAttribute("role", "status");
    }
    const pagination = document.createElement("nav");
    pagination.className = "oc-pagination";
    pagination.setAttribute("aria-label", branchText("branches.pageLabel"));
    const pageStatus = appendText(
      pagination,
      "span",
      branchText("branches.showing", {
        shown: items.length,
        total: result.total ?? 0,
      }),
    );
    pageStatus.setAttribute("role", "status");
    const controls = document.createElement("div");
    controls.className = "oc-pagination__controls";
    const previous = document.createElement("button");
    previous.className = "oc-button oc-button--secondary";
    previous.type = "button";
    previous.textContent = branchText("branches.previous");
    previous.disabled = branchOffset === 0;
    previous.addEventListener("click", () => {
      branchOffset = Math.max(0, branchOffset - 20);
      void loadBranchesView();
    });
    const next = document.createElement("button");
    next.className = "oc-button oc-button--secondary";
    next.type = "button";
    next.textContent = branchText("branches.next");
    next.disabled = branchOffset + items.length >= (result.total ?? 0);
    next.addEventListener("click", () => {
      branchOffset += 20;
      void loadBranchesView();
    });
    controls.append(previous, next);
    pagination.append(pageStatus, controls);
    content.append(pagination);
  } catch (requestError) {
    if (sequence !== branchLoadSequence || currentSession !== session) return;
    content.replaceChildren();
    appendBranchError(content, requestError, loadBranchesView);
  }
}

function businessResourceEndpoint(view) {
  const resource = view === "customers" ? "customers" : "catalog";
  const organizationId = currentSession?.organization?.organizationId;
  if (!organizationId) return null;
  return `/organizations/${encodeURIComponent(organizationId)}/business/${resource}`;
}

function clearBusinessManagerContext() {
  businessResourceSequence += 1;
  globalSearchSequence += 1;
  if (globalSearchDialog.open) globalSearchDialog.close();
  businessResourceContext = "";
  businessResourceOffsets.customers = 0;
  businessResourceOffsets.products = 0;
  businessResourceFilters.customers = {};
  businessResourceFilters.products = {};
  const content = document.querySelector("#boundary-content");
  content.replaceChildren();
  if (["customers", "products"].includes(location.hash.slice(1))) {
    appendText(
      content,
      "p",
      "Loading authorized records for the selected context…",
      "oc-state oc-state--loading",
    ).setAttribute("role", "status");
  }
}

function reloadBusinessManagerViewIfSelected() {
  const view = location.hash.slice(1);
  if (view === "customers" || view === "products") {
    void loadBusinessManagerView(view);
  }
}

function businessBranchLabel(branchId) {
  if (!branchId) return "Organization-wide";
  return (
    currentSession?.availableBranches.find(
      (branch) => branch.branchId === branchId,
    )?.name ?? "Authorized branch"
  );
}

function businessField(
  form,
  { name, label, type = "text", value, required, maxLength, options },
) {
  const field = document.createElement("div");
  field.className = "oc-field";
  const id = `business-${name}`;
  const labelElement = document.createElement("label");
  labelElement.htmlFor = id;
  labelElement.textContent = label;
  const input = options
    ? document.createElement("select")
    : document.createElement("input");
  input.id = id;
  input.name = name;
  input.required = Boolean(required);
  if (maxLength) input.maxLength = maxLength;
  if (options) {
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionLabel;
      input.append(option);
    }
  } else {
    input.type = type;
  }
  if (type === "email") input.autocomplete = "email";
  if (type === "tel") input.autocomplete = "tel";
  if (name === "price") input.inputMode = "decimal";
  if (name === "currency") input.maxLength = 3;
  input.value = value ?? "";
  field.append(labelElement, input);
  form.append(field);
  return input;
}

function renderBusinessTable(view, items, container, handlers) {
  const wrapper = document.createElement("div");
  wrapper.className = "oc-table-wrap";
  const table = document.createElement("table");
  table.className = "oc-table";
  const headings =
    view === "customers"
      ? [
          "Customer",
          "Reference",
          "Phone / email",
          "Branch",
          "Status",
          "Updated",
          "Actions",
        ]
      : [
          "Name",
          "SKU / reference",
          "Type",
          "Price",
          "Branch",
          "Status",
          "Updated",
          "Actions",
        ];
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const heading of headings) {
    const cell = appendText(headerRow, "th", heading);
    cell.scope = "col";
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  for (const item of items) {
    const row = document.createElement("tr");
    const values =
      view === "customers"
        ? [
            item.name,
            item.reference || "—",
            [item.phone, item.email].filter(Boolean).join(" · ") || "—",
            businessBranchLabel(item.branchId),
            item.status,
            formatDateTime(new Date(item.updatedAt), {
              locale: preferenceLocale,
            }),
          ]
        : [
            item.name,
            item.reference || "—",
            item.type,
            `${item.price} ${item.currency}`,
            businessBranchLabel(item.branchId),
            item.status,
            formatDateTime(new Date(item.updatedAt), {
              locale: preferenceLocale,
            }),
          ];
    for (let index = 0; index < values.length; index += 1) {
      const cell = document.createElement("td");
      if (
        (view === "customers" && index === 4) ||
        (view === "products" && index === 5)
      ) {
        cell.append(
          createStatusBadge(
            String(values[index]),
            statusVariant(String(values[index])),
          ),
        );
      } else {
        cell.textContent = String(values[index] ?? "—");
      }
      row.append(cell);
    }
    const actions = document.createElement("td");
    const viewButton = document.createElement("button");
    viewButton.className = "oc-button oc-button--quiet";
    viewButton.type = "button";
    viewButton.textContent = "View";
    viewButton.setAttribute("aria-label", `View ${item.name}`);
    viewButton.addEventListener("click", () => void handlers.view(item.id));
    const editButton = document.createElement("button");
    editButton.className = "oc-button oc-button--quiet";
    editButton.type = "button";
    editButton.textContent = "Edit";
    editButton.setAttribute("aria-label", `Edit ${item.name}`);
    editButton.addEventListener("click", () => void handlers.edit(item.id));
    const deleteButton = document.createElement("button");
    actions.append(viewButton, editButton);
    if (item.status === "ACTIVE") {
      deleteButton.className = "oc-button oc-button--quiet";
      deleteButton.type = "button";
      deleteButton.textContent = "Deactivate";
      deleteButton.setAttribute("aria-label", `Deactivate ${item.name}`);
      deleteButton.addEventListener(
        "click",
        () => void handlers.delete(item, deleteButton),
      );
      actions.append(deleteButton);
    }
    row.append(actions);
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  container.append(wrapper);
}

function renderBusinessFilters(view, container, state, onSubmit) {
  const form = document.createElement("form");
  form.className = "oc-card oc-grid";
  form.setAttribute(
    "aria-label",
    `${view === "customers" ? "Customer" : "Catalog"} filters`,
  );
  const search = businessField(form, {
    name: "search",
    label: "Search",
    value: state.search,
    maxLength: 100,
  });
  const status = businessField(form, {
    name: "status",
    label: "Status",
    options: [
      ["", "All statuses"],
      ["ACTIVE", "Active"],
      ["INACTIVE", "Inactive"],
    ],
    value: state.status,
  });
  if (view === "products") {
    businessField(form, {
      name: "type",
      label: "Type",
      options: [
        ["", "All types"],
        ["PRODUCT", "Product"],
        ["SERVICE", "Service"],
      ],
      value: state.type,
    });
  }
  if (currentSession?.branch?.branchId) {
    businessField(form, {
      name: "branchFilter",
      label: "Branch",
      options: [
        ["", "All authorized records"],
        ["CURRENT", "Current branch only"],
      ],
      value: state.branchFilter,
    });
  }
  const actions = document.createElement("div");
  actions.className = "oc-cluster";
  const submit = document.createElement("button");
  submit.className = "oc-button oc-button--secondary";
  submit.type = "submit";
  submit.textContent = "Apply filters";
  actions.append(submit);
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit({
      search: search.value.trim(),
      status: status.value,
      type: form.elements.namedItem("type")?.value ?? "",
      branchFilter: form.elements.namedItem("branchFilter")?.value ?? "",
    });
  });
  container.append(form);
}

function renderBusinessForm(view, mode, item, container, onCancel) {
  const isCustomer = view === "customers";
  const form = document.createElement("form");
  form.className = "oc-card oc-grid";
  form.noValidate = false;
  const editing = mode === "edit";
  const heading = appendText(
    form,
    "h2",
    `${editing ? "Edit" : "Create"} ${isCustomer ? "customer" : "catalog item"}`,
    "oc-section-title",
  );
  heading.id = "business-form-title";
  if (isCustomer) {
    businessField(form, {
      name: "name",
      label: "Name",
      value: item?.name,
      required: true,
      maxLength: 200,
    });
    businessField(form, {
      name: "reference",
      label: "Reference",
      value: item?.reference,
      maxLength: 100,
    });
    businessField(form, {
      name: "customerType",
      label: "Customer type",
      value: item?.customerType ?? "INDIVIDUAL",
      options: [
        ["INDIVIDUAL", "Individual"],
        ["BUSINESS", "Business"],
      ],
      required: true,
    });
    businessField(form, {
      name: "phone",
      label: "Phone",
      type: "tel",
      value: item?.phone,
      maxLength: 50,
    });
    businessField(form, {
      name: "email",
      label: "Email",
      type: "email",
      value: item?.email,
      maxLength: 320,
    });
    businessField(form, {
      name: "status",
      label: "Status",
      value: item?.status ?? "ACTIVE",
      options: [
        ["ACTIVE", "Active"],
        ["INACTIVE", "Inactive"],
      ],
    });
    const notesField = document.createElement("div");
    notesField.className = "oc-field";
    const notesLabel = document.createElement("label");
    notesLabel.htmlFor = "business-notes";
    notesLabel.textContent = "Notes";
    const notes = document.createElement("textarea");
    notes.id = "business-notes";
    notes.name = "notes";
    notes.maxLength = 2000;
    notes.rows = 4;
    notes.value = item?.notes ?? "";
    notesField.append(notesLabel, notes);
    form.append(notesField);
  } else {
    businessField(form, {
      name: "name",
      label: "Name",
      value: item?.name,
      required: true,
      maxLength: 200,
    });
    businessField(form, {
      name: "reference",
      label: "SKU / reference",
      value: item?.reference,
      maxLength: 100,
    });
    businessField(form, {
      name: "type",
      label: "Type",
      value: item?.type ?? "PRODUCT",
      options: [
        ["PRODUCT", "Product"],
        ["SERVICE", "Service"],
      ],
      required: true,
    });
    businessField(form, {
      name: "description",
      label: "Description",
      value: item?.description,
      maxLength: 2000,
    });
    businessField(form, {
      name: "unit",
      label: "Unit",
      value: item?.unit,
      required: true,
      maxLength: 50,
    });
    businessField(form, {
      name: "price",
      label: "Price (decimal)",
      value: item?.price,
      required: true,
      maxLength: 19,
    });
    businessField(form, {
      name: "currency",
      label: "Currency (ISO 4217)",
      value: item?.currency,
      required: true,
      maxLength: 3,
    });
    businessField(form, {
      name: "status",
      label: "Status",
      value: item?.status ?? "ACTIVE",
      options: [
        ["ACTIVE", "Active"],
        ["INACTIVE", "Inactive"],
      ],
    });
  }
  const error = document.createElement("p");
  error.className = "oc-alert oc-alert--error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "oc-cluster";
  const submit = document.createElement("button");
  submit.className = "oc-button";
  submit.type = "submit";
  submit.textContent = editing ? "Save changes" : "Create";
  const cancel = document.createElement("button");
  cancel.className = "oc-button oc-button--secondary";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", onCancel);
  actions.append(submit, cancel);
  form.append(error, actions);
  container.append(form);
  return { form, error };
}

async function loadBusinessManagerView(view, options = {}) {
  const sequence = ++businessResourceSequence;
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  const contextKey = `${organizationId ?? ""}:${session?.branch?.branchId ?? ""}`;
  if (contextKey !== businessResourceContext) {
    businessResourceContext = contextKey;
    businessResourceOffsets.customers = 0;
    businessResourceOffsets.products = 0;
    businessResourceFilters.customers = {};
    businessResourceFilters.products = {};
  }
  const filterState = options.filters ?? businessResourceFilters[view];
  const content = document.querySelector("#boundary-content");
  content.replaceChildren();
  if (!organizationId) {
    appendText(
      content,
      "p",
      "Select an organization to continue.",
      "oc-state oc-state--empty",
    );
    return;
  }
  const endpoint = businessResourceEndpoint(view);
  if (!endpoint) return;
  const detailLoading =
    options.mode && options.mode !== "create"
      ? appendText(
          content,
          "p",
          "Loading record…",
          "oc-state oc-state--loading",
        )
      : null;
  detailLoading?.setAttribute("role", "status");
  if (
    options.mode === "create" ||
    options.mode === "edit" ||
    options.mode === "view"
  ) {
    try {
      let item = options.item;
      if (options.mode !== "create") {
        const response = await authenticatedRequest(
          `${endpoint}/${encodeURIComponent(options.id)}`,
        );
        item = view === "customers" ? response.customer : response.item;
      }
      if (sequence !== businessResourceSequence || currentSession !== session)
        return;
      detailLoading?.remove();
      if (options.mode === "view") {
        renderDefinitionList(
          content,
          view === "customers"
            ? [
                ["Name", item.name],
                ["Reference", item.reference],
                ["Type", item.customerType],
                ["Phone", item.phone],
                ["Email", item.email],
                ["Branch", businessBranchLabel(item.branchId)],
                ["Status", item.status],
                ["Notes", item.notes],
                [
                  "Created",
                  formatDateTime(new Date(item.createdAt), {
                    locale: preferenceLocale,
                  }),
                ],
                [
                  "Updated",
                  formatDateTime(new Date(item.updatedAt), {
                    locale: preferenceLocale,
                  }),
                ],
              ]
            : [
                ["Name", item.name],
                ["Reference", item.reference],
                ["Type", item.type],
                ["Description", item.description],
                ["Unit", item.unit],
                ["Price", `${item.price} ${item.currency}`],
                ["Branch", businessBranchLabel(item.branchId)],
                ["Status", item.status],
                [
                  "Created",
                  formatDateTime(new Date(item.createdAt), {
                    locale: preferenceLocale,
                  }),
                ],
                [
                  "Updated",
                  formatDateTime(new Date(item.updatedAt), {
                    locale: preferenceLocale,
                  }),
                ],
              ],
        );
        const back = document.createElement("button");
        back.className = "oc-button oc-button--secondary";
        back.type = "button";
        back.textContent = "Back to list";
        back.addEventListener(
          "click",
          () => void loadBusinessManagerView(view),
        );
        content.append(back);
        return;
      }
      const { form, error } = renderBusinessForm(
        view,
        options.mode,
        item,
        content,
        () => void loadBusinessManagerView(view),
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const values = Object.fromEntries(new FormData(form));
        for (const key of [
          "reference",
          "phone",
          "email",
          "notes",
          "description",
        ]) {
          if (key in values && values[key] === "") values[key] = null;
        }
        if (view === "customers") {
          delete values.description;
          delete values.unit;
          delete values.price;
          delete values.currency;
          delete values.type;
        } else {
          delete values.customerType;
          delete values.phone;
          delete values.email;
          delete values.notes;
        }
        const controls = [
          ...form.querySelectorAll("input, select, textarea, button"),
        ];
        controls.forEach((control) => {
          control.disabled = true;
        });
        form.setAttribute("aria-busy", "true");
        try {
          await authenticatedRequest(
            options.mode === "edit"
              ? `${endpoint}/${encodeURIComponent(options.id)}`
              : endpoint,
            {
              method: options.mode === "edit" ? "PATCH" : "POST",
              body: values,
            },
          );
          announce(
            options.mode === "edit" ? "Record updated." : "Record created.",
            "success",
          );
          businessResourceOffsets[view] = 0;
          await loadBusinessManagerView(view, { filters: filterState });
        } catch (requestError) {
          error.textContent = errorMessage(requestError);
          show(error);
        } finally {
          controls.forEach((control) => {
            control.disabled = false;
          });
          form.removeAttribute("aria-busy");
        }
      });
      return;
    } catch (requestError) {
      if (sequence !== businessResourceSequence || currentSession !== session)
        return;
      detailLoading?.remove();
      appendBusinessError(
        content,
        requestError,
        () => void loadBusinessManagerView(view),
      );
      return;
    }
  }

  const heading = document.createElement("div");
  heading.className = "oc-main-header";
  const createButton = document.createElement("button");
  createButton.className = "oc-button";
  createButton.type = "button";
  createButton.textContent =
    view === "customers" ? "Create customer" : "Create catalog item";
  createButton.addEventListener(
    "click",
    () => void loadBusinessManagerView(view, { mode: "create" }),
  );
  heading.append(createButton);
  content.append(heading);
  renderBusinessFilters(view, content, filterState, (filters) => {
    businessResourceOffsets[view] = 0;
    businessResourceFilters[view] = filters;
    void loadBusinessManagerView(view, { filters });
  });
  const loading = appendText(
    content,
    "p",
    "Loading records…",
    "oc-state oc-state--loading",
  );
  loading.setAttribute("role", "status");
  try {
    const params = new globalThis.URLSearchParams({
      limit: "20",
      offset: String(businessResourceOffsets[view]),
    });
    if (filterState.search) params.set("search", filterState.search);
    if (filterState.status) params.set("status", filterState.status);
    if (filterState.type) params.set("type", filterState.type);
    if (filterState.branchFilter === "CURRENT" && session?.branch?.branchId) {
      params.set("branchId", session.branch.branchId);
    }
    const response = await authenticatedRequest(`${endpoint}?${params}`);
    if (sequence !== businessResourceSequence || currentSession !== session)
      return;
    loading.remove();
    if (!response.items?.length) {
      appendText(
        content,
        "p",
        businessResourceOffsets[view]
          ? "No more records."
          : `No ${view === "customers" ? "customers" : "catalog items"} found.`,
        "oc-state oc-state--empty",
      ).setAttribute("role", "status");
    } else {
      renderBusinessTable(view, response.items, content, {
        view: (id) =>
          void loadBusinessManagerView(view, {
            mode: "view",
            id,
            filters: filterState,
          }),
        edit: (id) =>
          void loadBusinessManagerView(view, {
            mode: "edit",
            id,
            filters: filterState,
          }),
        delete: async (item, button) => {
          if (
            !window.confirm(
              `Deactivate ${item.name}? This keeps its record for future references.`,
            )
          )
            return;
          button.disabled = true;
          try {
            await authenticatedRequest(
              `${endpoint}/${encodeURIComponent(item.id)}`,
              { method: "DELETE" },
            );
            announce("Record deactivated.", "success");
            await loadBusinessManagerView(view, { filters: filterState });
          } catch (requestError) {
            appendBusinessError(
              content,
              requestError,
              () =>
                void loadBusinessManagerView(view, { filters: filterState }),
            );
          } finally {
            button.disabled = false;
          }
        },
      });
    }
    const pagination = document.createElement("nav");
    pagination.className = "oc-pagination";
    pagination.setAttribute(
      "aria-label",
      `${view === "customers" ? "Customers" : "Catalog"} pages`,
    );
    const pageStatus = appendText(
      pagination,
      "span",
      `Showing ${response.items?.length ?? 0} of ${response.total ?? 0}`,
    );
    pageStatus.setAttribute("role", "status");
    const controls = document.createElement("div");
    controls.className = "oc-pagination__controls";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "oc-button oc-button--secondary";
    previous.textContent = "Previous";
    previous.disabled = businessResourceOffsets[view] === 0;
    previous.addEventListener("click", () => {
      businessResourceOffsets[view] = Math.max(
        0,
        businessResourceOffsets[view] - 20,
      );
      void loadBusinessManagerView(view, { filters: filterState });
    });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "oc-button oc-button--secondary";
    next.textContent = "Next";
    next.disabled = businessResourceOffsets[view] + 20 >= (response.total ?? 0);
    next.addEventListener("click", () => {
      businessResourceOffsets[view] += 20;
      void loadBusinessManagerView(view, { filters: filterState });
    });
    controls.append(previous, next);
    pagination.append(controls);
    content.append(pagination);
  } catch (requestError) {
    if (sequence !== businessResourceSequence || currentSession !== session)
      return;
    loading.remove();
    appendBusinessError(
      content,
      requestError,
      () => void loadBusinessManagerView(view, { filters: filterState }),
    );
  }
}

function appendBusinessError(container, error, retry) {
  const alert = appendText(
    container,
    "div",
    error instanceof ApiError && error.status === 403
      ? "You are not authorized to access this Business Manager resource."
      : errorMessage(error),
    "oc-alert oc-alert--error",
  );
  alert.setAttribute("role", "alert");
  const button = document.createElement("button");
  button.className = "oc-button oc-button--secondary";
  button.type = "button";
  button.textContent = "Retry";
  button.addEventListener("click", retry);
  container.append(button);
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
  document.querySelector("#dashboard-organizations-count").textContent =
    new Intl.NumberFormat(preferenceLocale).format(session.memberships.length);
  document.querySelector("#dashboard-branches-count").textContent =
    organizationId
      ? new Intl.NumberFormat(preferenceLocale).format(
          session.availableBranches.length,
        )
      : "—";
  document.querySelector("#dashboard-modules-count").textContent = "—";
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
    document.querySelector("#dashboard-modules-count").textContent =
      new Intl.NumberFormat(preferenceLocale).format(
        [...entitlements.values()].filter((status) => status === "ENABLED")
          .length,
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
    document.querySelector("#notification-indicator").hidden = !rows.some(
      (item) => !item.readAt,
    );
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
    document.querySelector("#notification-indicator").hidden = true;
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
      "customers-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/business/customers?limit=1`,
    ],
    [
      "products-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/business/catalog?limit=1`,
    ],
    [
      "branches-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/branches?limit=1`,
    ],
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
  document.querySelector("#language-shortcut").hidden = true;
  document.querySelector("#notification-shortcut").hidden = true;
  document.querySelector("#dashboard-customers-action").hidden = true;
  document.querySelector("#dashboard-catalog-action").hidden = true;
  document.querySelector("#dashboard-modules-link").hidden = true;
  document.querySelector("#dashboard-notifications-link").hidden = true;
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
          if (id === "customers-nav") {
            document.querySelector("#dashboard-customers-action").hidden =
              false;
          } else if (id === "products-nav") {
            document.querySelector("#dashboard-catalog-action").hidden = false;
          } else if (id === "branches-nav") {
            setBranchesNavigationText();
          } else if (id === "notifications-nav") {
            document.querySelector("#notification-shortcut").hidden = false;
            document.querySelector("#dashboard-notifications-link").hidden =
              false;
          } else if (id === "preferences-nav") {
            document.querySelector("#language-shortcut").hidden = false;
          } else if (id === "modules-nav") {
            document.querySelector("#dashboard-modules-link").hidden = false;
          }
        }
      } catch {
        if (sequence === resourceNavigationSequence) {
          document.querySelector(`#${id}`).hidden = true;
        }
      }
    }),
  );
}

async function runGlobalSearch(event) {
  event.preventDefault();
  const query = globalSearchInput.value.trim();
  const status = document.querySelector("#global-search-status");
  const results = document.querySelector("#global-search-results");
  const sequence = ++globalSearchSequence;
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  results.replaceChildren();
  if (!organizationId || query.length < 2) {
    status.textContent = organizationId
      ? "Enter at least two characters to search."
      : "Choose an organization before searching.";
    globalSearchDialog.showModal();
    return;
  }
  const targets = [
    { view: "customers", navId: "customers-nav", label: "Customer" },
    { view: "products", navId: "products-nav", label: "Catalog item" },
  ].filter(({ navId }) => !document.querySelector(`#${navId}`).hidden);
  if (targets.length === 0) {
    status.textContent =
      "No searchable resources are available in this workspace.";
    globalSearchDialog.showModal();
    return;
  }
  status.textContent = "Searching authorized records…";
  globalSearchDialog.showModal();
  const params = new globalThis.URLSearchParams({
    search: query,
    limit: "5",
    offset: "0",
  });
  const responses = await Promise.allSettled(
    targets.map(async (target) => ({
      target,
      response: await authenticatedRequest(
        `${businessResourceEndpoint(target.view)}?${params}`,
      ),
    })),
  );
  if (
    sequence !== globalSearchSequence ||
    currentSession !== session ||
    !globalSearchDialog.open
  ) {
    return;
  }
  let successfulSearches = 0;
  let failedSearch;
  for (const result of responses) {
    if (result.status === "rejected") {
      failedSearch ??= result.reason;
      continue;
    }
    successfulSearches += 1;
    for (const item of result.value.response.items ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "oc-search-result";
      const details = document.createElement("span");
      details.className = "oc-search-result__details";
      appendText(details, "strong", item.name);
      appendText(
        details,
        "span",
        [
          result.value.target.label,
          item.reference,
          result.value.target.view === "products" ? item.type : null,
        ]
          .filter(Boolean)
          .join(" · "),
        "oc-muted",
      );
      button.append(details);
      button.addEventListener("click", () => {
        const view = result.value.target.view;
        const filters = {
          search: query,
          status: "",
          type: "",
          branchFilter: "",
        };
        businessResourceFilters[view] = filters;
        businessResourceOffsets[view] = 0;
        globalSearchDialog.close();
        if (location.hash === `#${view}`) {
          void loadBusinessManagerView(view, { filters });
        } else {
          location.hash = view;
        }
      });
      results.append(button);
    }
  }
  if (results.childElementCount > 0) {
    status.textContent = `Search results for “${query}”`;
  } else if (failedSearch && successfulSearches > 0) {
    status.textContent =
      "Some authorized resources could not be searched. No matches were found in available results.";
  } else if (successfulSearches > 0) {
    status.textContent = "No matching customers or catalog items were found.";
  } else {
    status.textContent = errorMessage(failedSearch);
    results.append(
      appendText(
        document.createElement("div"),
        "p",
        failedSearch instanceof ApiError && failedSearch.status === 403
          ? "Access to search results is restricted."
          : "Search could not be completed. Try again.",
        "oc-state oc-state--error",
      ),
    );
  }
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

function userInitials(displayName, email) {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return `${words[0][0]}${words.at(-1)[0]}`.toLocaleUpperCase();
  }
  return (words[0]?.slice(0, 2) || email.slice(0, 2)).toLocaleUpperCase();
}

function selectView(view) {
  businessResourceSequence += 1;
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
  if (selected !== "branches") branchLoadSequence += 1;
  const pageTitle =
    resourceViews[selected]?.title ??
    boundaryViews[selected]?.title ??
    (selected === "overview" ? "Dashboard" : "OneCore workspace");
  document.title = `${pageTitle} · OneCore`;
  document.querySelector("#dashboard-modules-link").hidden =
    document.querySelector("#modules-nav").hidden;
  document.querySelector("#dashboard-notifications-link").hidden =
    document.querySelector("#notifications-nav").hidden;
  document.querySelector("#dashboard-workflows-link").hidden =
    document.querySelector("#workflow-nav").hidden;
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
  menuToggle.setAttribute("aria-label", "Open navigation");
  sidebarBackdrop.hidden = true;
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
  globalSearchSequence += 1;
  const previousOrganizationId = currentSession?.organization?.organizationId;
  currentSession = session;
  if (previousOrganizationId !== session.organization?.organizationId) {
    branchOffset = 0;
    branchLoadSequence += 1;
  }
  setBranchesNavigationText();
  hide(loadingView);
  hide(errorView);
  hide(authView);
  show(appView);
  userLabel.textContent = session.user.displayName;
  const initials = userInitials(session.user.displayName, session.user.email);
  document.querySelector("#dashboard-greeting-name").textContent =
    session.user.displayName;
  const hour = new Date().getHours();
  document.querySelector("#dashboard-greeting-prefix").textContent =
    hour < 12
      ? "Good morning,"
      : hour < 18
        ? "Good afternoon,"
        : "Good evening,";
  document.querySelector("#sidebar-user-name").textContent =
    session.user.displayName;
  document.querySelector("#sidebar-user-email").textContent =
    session.user.email;
  document.querySelector("#sidebar-organization").textContent =
    session.organization?.name ?? "No organization selected";
  const activeBranch = session.availableBranches.find(
    (branch) => branch.branchId === session.branch?.branchId,
  );
  document.querySelector("#sidebar-branch").textContent = session.branch
    ? (activeBranch?.name ?? "Selected branch")
    : "Organization-wide access";
  for (const selector of ["#sidebar-avatar", "#header-avatar"]) {
    document.querySelector(selector).textContent = initials;
  }
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
  document.querySelector("#dashboard-organizations-count").textContent =
    new Intl.NumberFormat(preferenceLocale).format(session.memberships.length);
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

document
  .querySelector("#password-visibility")
  .addEventListener("click", (event) => {
    const button = event.currentTarget;
    const password = document.querySelector("#login-password");
    const visible = password.type === "password";
    password.type = visible ? "text" : "password";
    button.textContent = visible ? "Hide" : "Show";
    button.setAttribute(
      "aria-label",
      visible ? "Hide password" : "Show password",
    );
    button.setAttribute("aria-pressed", String(visible));
  });

globalSearchForm.addEventListener("submit", runGlobalSearch);
document
  .querySelector("#global-search-close")
  .addEventListener("click", () => globalSearchDialog.close());
globalSearchDialog.addEventListener("close", () => {
  globalSearchInput.focus();
});

organizationSelect.addEventListener("change", async () => {
  if (!organizationSelect.value || !currentSession) {
    organizationSelect.value =
      currentSession?.organization?.organizationId ?? "";
    return;
  }
  clearBusinessManagerContext();
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
    reloadBusinessManagerViewIfSelected();
  } finally {
    organizationSelect.disabled = false;
  }
});

branchSelect.addEventListener("change", async () => {
  if (!branchSelect.value || !currentSession?.organization) {
    branchSelect.value = currentSession?.branch?.branchId ?? "";
    return;
  }
  clearBusinessManagerContext();
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
    reloadBusinessManagerViewIfSelected();
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
    menuToggle.setAttribute("aria-label", "Open navigation");
    sidebarBackdrop.hidden = true;
  });
});
menuToggle.addEventListener("click", () => {
  const expanded = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!expanded));
  menuToggle.setAttribute(
    "aria-label",
    expanded ? "Open navigation" : "Close navigation",
  );
  sidebar.dataset.open = String(!expanded);
  sidebarBackdrop.hidden = expanded;
  if (!expanded) {
    sidebar.querySelector(".oc-nav a:not([hidden])")?.focus();
  }
});
sidebarBackdrop.addEventListener("click", () => {
  sidebar.dataset.open = "false";
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation");
  sidebarBackdrop.hidden = true;
  menuToggle.focus();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
  ) {
    event.preventDefault();
    globalSearchInput.focus();
    return;
  }
  if (
    event.key !== "Escape" ||
    menuToggle.getAttribute("aria-expanded") !== "true"
  ) {
    return;
  }
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation");
  sidebar.dataset.open = "false";
  sidebarBackdrop.hidden = true;
  menuToggle.focus();
});
themeToggle.addEventListener("click", () => {
  currentTheme = (currentTheme + 1) % themeOptions.length;
  const theme = themeOptions[currentTheme];
  setTheme(theme);
  themeToggle.setAttribute(
    "aria-label",
    `Change theme, current theme: ${theme}`,
  );
  themeToggle.title = `Theme: ${theme}`;
});

setWorkflowText();
void refreshSession();
