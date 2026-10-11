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
import {
  addDraftCartItem,
  catalogPriceToScaledAmount,
  createSaleCheckoutController,
  draftCartSubtotal,
  formatScaledAmount,
  removeDraftCartItem,
  saleCheckoutMessage,
  setDraftCartQuantity,
} from "./pos.js";

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
const memberMessages = {
  en: {
    "member.nav": "Users & members",
    "member.title": "Organization members",
    "member.description":
      "View organization members and, where authorized, manage their assigned roles.",
    "member.loading": "Loading organization members…",
    "member.selectOrganization": "Select an organization to view its members.",
    "member.empty": "No organization members are available.",
    "member.accessDenied":
      "You are not authorized to view organization members.",
    "member.rolesAccessDenied":
      "You are not authorized to view this member's roles.",
    "member.name": "Name",
    "member.email": "Email",
    "member.status": "Membership status",
    "member.added": "Added",
    "member.roles": "Roles",
    "member.manageRoles": "Manage roles",
    "member.branchAccess": "Branch access",
    "member.manageBranches": "Manage branch access",
    "member.branchMode": "Access mode",
    "member.allBranches": "All active branches",
    "member.assignedBranches": "Assigned branches",
    "member.noAssignedBranches": "No branches are explicitly assigned.",
    "member.availableBranches": "Available active branches",
    "member.noAvailableBranches":
      "No additional active branches are available.",
    "member.assignBranch": "Assign branch",
    "member.removeBranch": "Remove assignment",
    "member.confirmBranchRemoval": "Remove this branch assignment?",
    "member.branchUpdated": "Branch assignments updated.",
    "member.branchesLoading": "Loading branch assignments…",
    "member.branchesAccessDenied":
      "You are not authorized to view this member's branch assignments.",
    "member.allModeReadOnly":
      "This member has access to all active branches; explicit assignments cannot be changed.",
    "member.rolesLoading": "Loading roles…",
    "member.assignedRoles": "Assigned roles",
    "member.noAssignedRoles": "No roles are assigned.",
    "member.inactiveRole": "Inactive",
    "member.availableRoles": "Available roles",
    "member.noAvailableRoles": "No additional active roles are available.",
    "member.assignRole": "Assign role",
    "member.removeRole": "Remove",
    "member.confirmRoleRemoval": "Remove this role from the member?",
    "member.roleUpdated": "Member roles updated.",
    "member.pages": "Organization member pages",
    "member.previous": "Previous",
    "member.next": "Next",
  },
  sw: {
    "member.nav": "Watumiaji na wanachama",
    "member.title": "Wanachama wa shirika",
    "member.description":
      "Tazama wanachama wa shirika na udhibiti majukumu yao pale unaporuhusiwa.",
    "member.loading": "Inapakia wanachama wa shirika…",
    "member.selectOrganization": "Chagua shirika ili kutazama wanachama wake.",
    "member.empty": "Hakuna wanachama wa shirika wanaopatikana.",
    "member.accessDenied": "Huna ruhusa ya kutazama wanachama wa shirika.",
    "member.rolesAccessDenied":
      "Huna ruhusa ya kuona majukumu ya mwanachama huyu.",
    "member.name": "Jina",
    "member.email": "Barua pepe",
    "member.status": "Hali ya uanachama",
    "member.added": "Aliongezwa",
    "member.roles": "Majukumu",
    "member.manageRoles": "Dhibiti majukumu",
    "member.branchAccess": "Ufikiaji wa matawi",
    "member.manageBranches": "Dhibiti ufikiaji wa matawi",
    "member.branchMode": "Aina ya ufikiaji",
    "member.allBranches": "Matawi yote yanayotumika",
    "member.assignedBranches": "Matawi yaliyopangiwa",
    "member.noAssignedBranches": "Hakuna matawi yaliyopangiwa moja kwa moja.",
    "member.availableBranches": "Matawi yanayotumika",
    "member.noAvailableBranches": "Hakuna matawi mengine yanayopatikana.",
    "member.assignBranch": "Pangia tawi",
    "member.removeBranch": "Ondoa upangaji",
    "member.confirmBranchRemoval": "Ondoa upangaji huu wa tawi?",
    "member.branchUpdated": "Upangaji wa matawi umesasishwa.",
    "member.branchesLoading": "Inapakia upangaji wa matawi…",
    "member.branchesAccessDenied":
      "Huna ruhusa ya kuona upangaji wa matawi ya mwanachama huyu.",
    "member.allModeReadOnly":
      "Mwanachama huyu anaweza kufikia matawi yote yanayotumika; upangaji wa moja kwa moja hauwezi kubadilishwa.",
    "member.rolesLoading": "Inapakia majukumu…",
    "member.assignedRoles": "Majukumu yaliyopangiwa",
    "member.noAssignedRoles": "Hakuna majukumu yaliyopangiwa.",
    "member.inactiveRole": "Haifanyi kazi",
    "member.availableRoles": "Majukumu yanayopatikana",
    "member.noAvailableRoles": "Hakuna majukumu mengine yanayotumika.",
    "member.assignRole": "Pangia jukumu",
    "member.removeRole": "Ondoa",
    "member.confirmRoleRemoval": "Ondoa jukumu hili kwa mwanachama?",
    "member.roleUpdated": "Majukumu ya mwanachama yamesasishwa.",
    "member.pages": "Kurasa za wanachama wa shirika",
    "member.previous": "Iliyotangulia",
    "member.next": "Inayofuata",
  },
};
const branchMessages = {
  en: {
    "branch.title": "Organization branches",
    "branch.description":
      "View all organization branches and manage branch details and active status.",
    "branch.loading": "Loading organization branches…",
    "branch.selectOrganization": "Select an organization to manage branches.",
    "branch.name": "Branch name",
    "branch.code": "Branch code",
    "branch.status": "Status",
    "branch.created": "Create branch",
    "branch.save": "Save changes",
    "branch.status.active": "Active",
    "branch.status.inactive": "Inactive",
    "branch.empty": "No branches are recorded for this organization.",
    "branch.denied": "You are not authorized to view organization branches.",
    "branch.previous": "Previous",
    "branch.next": "Next",
    "branch.pages": "Organization branch pages",
    "branch.createdSuccess": "Branch created.",
    "branch.updatedSuccess": "Branch updated.",
  },
  sw: {
    "branch.title": "Matawi ya shirika",
    "branch.description":
      "Tazama matawi yote ya shirika na udhibiti maelezo na hali ya tawi.",
    "branch.loading": "Inapakia matawi ya shirika…",
    "branch.selectOrganization": "Chagua shirika ili kudhibiti matawi.",
    "branch.name": "Jina la tawi",
    "branch.code": "Msimbo wa tawi",
    "branch.status": "Hali",
    "branch.created": "Unda tawi",
    "branch.save": "Hifadhi mabadiliko",
    "branch.status.active": "Linafanya kazi",
    "branch.status.inactive": "Halifanyi kazi",
    "branch.empty": "Hakuna matawi yaliyorekodiwa kwa shirika hili.",
    "branch.denied": "Huna ruhusa ya kuona matawi ya shirika.",
    "branch.previous": "Iliyotangulia",
    "branch.next": "Inayofuata",
    "branch.pages": "Kurasa za matawi ya shirika",
    "branch.createdSuccess": "Tawi limeundwa.",
    "branch.updatedSuccess": "Tawi limesasishwa.",
  },
};
let currentTheme = 0;
let currentSession;
let workflowLoadSequence = 0;
let dashboardLoadSequence = 0;
let workflowNavigationSequence = 0;
let globalSearchSequence = 0;
let resourceLoadSequence = 0;
let resourceNavigationSequence = 0;
let businessResourceSequence = 0;
let businessResourceContext = "";
let posLoadSequence = 0;
let posContext = "";
let posSearch = "";
let posOffset = 0;
const posCart = new Map();
let posCheckoutSubmitting = false;
let posCheckoutNotice = null;
let posSaleConfirmation = null;
let memberLoadSequence = 0;
let memberOffset = 0;
let memberContext = "";
let branchLoadSequence = 0;
let branchOffset = 0;
let branchContext = "";
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
      "View and manage organization branches. Branch selection remains verified by the server.",
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
  pos: {
    title: "Point of sale",
    description:
      "Browse active catalog items and create an unpaid OPEN sale from an authorized branch. Server pricing is authoritative; tax, discounts, and payment are not included.",
    eyebrow: "Sales workspace",
  },
  members: {
    title: "Users & members",
    description:
      "View memberships in your verified organization. The API controls access to member information.",
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

function branchText(key) {
  return translate(key, {
    locale: preferenceLocale,
    messages: branchMessages,
    fallbackText: key,
  });
}

function memberText(key) {
  return translate(key, {
    locale: preferenceLocale,
    messages: memberMessages,
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
  resetPosWorkspaceState({ clearCart: false });
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

let posCheckoutStorage;
try {
  posCheckoutStorage = globalThis.sessionStorage;
} catch {
  posCheckoutStorage = null;
}
const posCheckoutController = createSaleCheckoutController({
  storage: posCheckoutStorage,
  request: (path, options) => authenticatedRequest(path, options),
  createKey: () => globalThis.crypto.randomUUID(),
});

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

function renderBusinessProfileForm(container, result, organizationId) {
  const form = document.createElement("form");
  form.className = "oc-card oc-stack";
  form.setAttribute("aria-label", "Update business contact and address");
  appendText(form, "h2", "Contact and address", "oc-section-title");
  appendText(
    form,
    "p",
    "These business profile fields are saved through the organization settings API.",
    "oc-help",
  );
  const profile = result.businessProfile ?? {};
  const fields = [
    {
      name: "contactEmail",
      label: "Business contact email",
      type: "email",
      maxLength: 320,
      value: profile.contactEmail,
    },
    {
      name: "contactPhone",
      label: "Business contact phone",
      type: "tel",
      maxLength: 50,
      value: profile.contactPhone,
    },
    {
      name: "website",
      label: "Website",
      type: "url",
      maxLength: 2048,
      value: profile.website,
    },
    {
      name: "countryCode",
      label: "Business address country code",
      maxLength: 2,
      pattern: "[A-Z]{2}",
      value: profile.countryCode,
    },
    {
      name: "region",
      label: "County / region",
      maxLength: 100,
      value: profile.region,
    },
    {
      name: "city",
      label: "Town / city",
      maxLength: 100,
      value: profile.city,
    },
    {
      name: "address",
      label: "Street / postal address",
      maxLength: 300,
      value: profile.address,
    },
  ];
  const grid = document.createElement("div");
  grid.className = "oc-form-grid";
  for (const field of fields) {
    const wrapper = document.createElement("div");
    wrapper.className = "oc-field";
    const inputId = `business-profile-${field.name}`;
    const label = document.createElement("label");
    label.htmlFor = inputId;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = inputId;
    input.name = field.name;
    input.type = field.type ?? "text";
    input.className = "oc-input";
    input.maxLength = field.maxLength;
    input.value = field.value ?? "";
    if (field.pattern) input.pattern = field.pattern;
    if (field.name === "contactEmail") input.autocomplete = "email";
    if (field.name === "contactPhone") input.autocomplete = "tel";
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
  save.textContent = "Save business profile";
  form.append(grid, error, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hide(error);
    if (!form.reportValidity()) return;
    const businessProfile = Object.fromEntries(new FormData(form));
    for (const [key, value] of Object.entries(businessProfile)) {
      businessProfile[key] = value.trim() || null;
    }
    setBusy(save, true);
    try {
      await authenticatedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/configuration`,
        { method: "PATCH", body: { businessProfile } },
      );
      announce("Business contact and address saved.", "success");
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
        "Organization lifecycle status and a separate display-name editor are not exposed by the current API.",
        "oc-help",
      );
      if (result.permissions?.canUpdateSettings === true) {
        renderBusinessProfileForm(container, result, organizationId);
      } else {
        appendText(
          container,
          "p",
          "You can view this business profile but do not have permission to update it.",
          "oc-help",
        );
      }
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
    if (result.permissions?.canUpdateSettings === true) {
      renderRegionalSettingsForm(container, result, organizationId);
    } else {
      appendText(
        container,
        "p",
        "You can view organization settings but do not have permission to update them.",
        "oc-help",
      );
    }
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
  if (view === "pos") {
    void loadPosWorkspace(content);
    return;
  }
  if (view === "branches") {
    document.querySelector("#boundary-title").textContent =
      branchText("branch.title");
    document.querySelector("#boundary-description").textContent =
      branchText("branch.description");
    void loadBranchesView(content);
    return;
  }
  if (view === "members") {
    document.querySelector("#boundary-title").textContent =
      memberText("member.title");
    document.querySelector("#boundary-description").textContent =
      memberText("member.description");
    void loadMembersView(content);
    return;
  }
  appendText(
    content,
    "div",
    "Audit records are written by the platform, but there is no tenant-authorized audit read API available to this workspace. No activity is fabricated or inferred from unrelated data.",
    "oc-state oc-state--empty",
  );
}

async function loadBranchesView(content, statusMessage) {
  const sequence = ++branchLoadSequence;
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  const context = organizationId ?? "";
  if (context !== branchContext) {
    branchContext = context;
    branchOffset = 0;
  }
  content.replaceChildren();
  if (!organizationId) {
    appendText(
      content,
      "p",
      branchText("branch.selectOrganization"),
      "oc-state oc-state--empty",
    );
    return;
  }

  const choices = session?.availableBranches ?? [];
  appendText(content, "h2", "Your available branch context", "oc-section-title");
  if (choices.length > 0) {
    renderSimpleTable(
      content,
      ["Branch", "Code", "Context"],
      choices.map((branch) => [
        branch.name,
        branch.code || "—",
        branch.branchId === session.branch?.branchId
          ? "Selected"
          : "Available for selection",
      ]),
    );
  } else {
    appendText(
      content,
      "p",
      "No active branches are available to your current organization membership.",
      "oc-state oc-state--empty",
    );
  }
  appendText(
    content,
    "p",
    "Branch choices come only from the authenticated session response. Use the verified branch selector above to switch context.",
    "oc-help",
  );

  const administration = document.createElement("section");
  administration.className = "oc-stack";
  administration.setAttribute("aria-label", branchText("branch.title"));
  content.append(administration);
  void loadBranchAdministration(
    administration,
    organizationId,
    session,
    sequence,
    statusMessage,
  );
}

async function loadBranchAdministration(
  container,
  organizationId,
  session,
  sequence,
  statusMessage,
) {
  const heading = appendText(
    container,
    "h2",
    branchText("branch.title"),
    "oc-section-title",
  );
  heading.id = "branch-administration-heading";
  const loading = appendText(
    container,
    "p",
    branchText("branch.loading"),
    "oc-state oc-state--loading",
  );
  loading.setAttribute("role", "status");
  try {
    const result = await authenticatedRequest(
      `/organizations/${encodeURIComponent(organizationId)}/branches?limit=20&offset=${branchOffset}`,
    );
    if (sequence !== branchLoadSequence || currentSession !== session) return;
    container.replaceChildren(heading);
    if (statusMessage) {
      const status = appendText(container, "p", statusMessage, "oc-muted");
      status.setAttribute("role", "status");
    }

    if (result.capabilities?.canCreate === true) {
      const form = document.createElement("form");
      form.className = "oc-stack";
      const formHeading = appendText(
        form,
        "h3",
        branchText("branch.created"),
        "oc-section-title",
      );
      formHeading.id = "branch-create-heading";
    const grid = document.createElement("div");
    grid.className = "oc-form-grid";
    const nameField = createBranchInput(
      "branch-new-name",
      "name",
      branchText("branch.name"),
      200,
    );
    const codeField = createBranchInput(
      "branch-new-code",
      "code",
      branchText("branch.code"),
      50,
      "[A-Za-z0-9][A-Za-z0-9_-]*",
    );
    grid.append(nameField.wrapper, codeField.wrapper);
    const error = document.createElement("p");
    error.className = "oc-alert oc-alert--error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const create = document.createElement("button");
    create.type = "submit";
    create.className = "oc-button";
    create.textContent = branchText("branch.created");
    form.append(grid, error, create);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      create.disabled = true;
      try {
        await authenticatedRequest(
          `/organizations/${encodeURIComponent(organizationId)}/branches`,
          {
            method: "POST",
            body: {
              name: nameField.input.value,
              code: codeField.input.value,
            },
          },
        );
        branchOffset = 0;
        await loadBranchesView(
          document.querySelector("#boundary-content"),
          branchText("branch.createdSuccess"),
        );
      } catch (requestError) {
        error.textContent = errorMessage(requestError);
        error.hidden = false;
        create.disabled = false;
      }
    });
      container.append(form);
    }

    const branches = Array.isArray(result.branches) ? result.branches : [];
    if (branches.length === 0 && branchOffset === 0) {
      appendText(
        container,
        "p",
        branchText("branch.empty"),
        "oc-state oc-state--empty",
      );
    } else {
      for (const branch of branches) {
        const card = document.createElement("article");
        card.className = "oc-card oc-stack";
        appendText(card, "h3", branch.name, "oc-section-title");
        appendText(card, "p", `${branch.code} · ${branch.status}`, "oc-muted");
        if (result.capabilities?.canUpdate === true) {
          const updateForm = document.createElement("form");
        updateForm.className = "oc-stack";
        const updateGrid = document.createElement("div");
        updateGrid.className = "oc-form-grid";
        const branchName = createBranchInput(
          `branch-${branch.id}-name`,
          "name",
          branchText("branch.name"),
          200,
        );
        branchName.input.value = branch.name;
        const branchCode = createBranchInput(
          `branch-${branch.id}-code`,
          "code",
          branchText("branch.code"),
          50,
          "[A-Za-z0-9][A-Za-z0-9_-]*",
        );
        branchCode.input.value = branch.code;
        const statusWrapper = document.createElement("div");
        statusWrapper.className = "oc-field";
        const statusLabel = document.createElement("label");
        statusLabel.htmlFor = `branch-${branch.id}-status`;
        statusLabel.textContent = branchText("branch.status");
        const statusSelect = document.createElement("select");
        statusSelect.id = statusLabel.htmlFor;
        statusSelect.name = "status";
        statusSelect.className = "oc-input";
        const unchanged = document.createElement("option");
        unchanged.value = "";
        unchanged.textContent = `${branchText("branch.status")}: ${branch.status}`;
        statusSelect.append(unchanged);
        for (const statusValue of ["ACTIVE", "INACTIVE"]) {
          const option = document.createElement("option");
          option.value = statusValue;
          option.textContent = branchText(`branch.status.${statusValue.toLowerCase()}`);
          statusSelect.append(option);
        }
        updateGrid.append(
          branchName.wrapper,
          branchCode.wrapper,
          statusWrapper,
        );
        statusWrapper.append(statusLabel, statusSelect);
        const updateError = document.createElement("p");
        updateError.className = "oc-alert oc-alert--error";
        updateError.setAttribute("role", "alert");
        updateError.hidden = true;
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "oc-button oc-button--secondary";
        save.textContent = branchText("branch.save");
        updateForm.append(updateGrid, updateError, save);
        updateForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          updateError.hidden = true;
          save.disabled = true;
          const body = {
            name: branchName.input.value,
            code: branchCode.input.value,
            ...(statusSelect.value ? { status: statusSelect.value } : {}),
          };
          try {
            await authenticatedRequest(
              `/organizations/${encodeURIComponent(organizationId)}/branches/${encodeURIComponent(branch.id)}`,
              { method: "PATCH", body },
            );
            await loadBranchesView(
              document.querySelector("#boundary-content"),
              branchText("branch.updatedSuccess"),
            );
          } catch (requestError) {
            updateError.textContent = errorMessage(requestError);
            updateError.hidden = false;
            save.disabled = false;
          }
        });
          card.append(updateForm);
        }
        container.append(card);
      }
    }
    const pagination = document.createElement("nav");
    pagination.className = "oc-pagination";
    pagination.setAttribute("aria-label", branchText("branch.pages"));
    const controls = document.createElement("div");
    controls.className = "oc-pagination__controls";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "oc-button oc-button--secondary";
    previous.textContent = branchText("branch.previous");
    previous.disabled = branchOffset === 0;
    previous.addEventListener("click", () => {
      branchOffset = Math.max(0, branchOffset - 20);
      void loadBranchesView(document.querySelector("#boundary-content"));
    });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "oc-button oc-button--secondary";
    next.textContent = branchText("branch.next");
    next.disabled = !result.hasMore;
    next.addEventListener("click", () => {
      branchOffset += 20;
      void loadBranchesView(document.querySelector("#boundary-content"));
    });
    controls.append(previous, next);
    pagination.append(controls);
    container.append(pagination);
  } catch (requestError) {
    if (sequence !== branchLoadSequence || currentSession !== session) return;
    container.replaceChildren(heading);
    const error = appendText(
      container,
      "p",
      requestError instanceof ApiError && requestError.status === 403
        ? branchText("branch.denied")
        : errorMessage(requestError),
      "oc-alert oc-alert--error",
    );
    error.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "oc-button oc-button--secondary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void loadBranchesView(document.querySelector("#boundary-content"));
    });
    container.append(retry);
  }
}

function createBranchInput(id, name, labelText, maxLength, pattern) {
  const wrapper = document.createElement("div");
  wrapper.className = "oc-field";
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  const input = document.createElement("input");
  input.id = id;
  input.name = name;
  input.type = "text";
  input.className = "oc-input";
  input.maxLength = maxLength;
  input.required = true;
  if (pattern) input.pattern = pattern;
  wrapper.append(label, input);
  return { wrapper, input };
}

async function loadMembersView(content) {
  const sequence = ++memberLoadSequence;
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  const context = `${organizationId ?? ""}:${session?.branch?.branchId ?? ""}`;
  if (context !== memberContext) {
    memberContext = context;
    memberOffset = 0;
  }
  content.replaceChildren();
  if (!organizationId) {
    appendText(
      content,
      "p",
      memberText("member.selectOrganization"),
      "oc-state oc-state--empty",
    );
    return;
  }

  const loading = appendText(
    content,
    "p",
    memberText("member.loading"),
    "oc-state oc-state--loading",
  );
  loading.setAttribute("role", "status");
  try {
    const result = await authenticatedRequest(
      `/organizations/${encodeURIComponent(organizationId)}/members?limit=20&offset=${memberOffset}`,
    );
    if (sequence !== memberLoadSequence || currentSession !== session) return;
    content.replaceChildren();
    const members = Array.isArray(result.members) ? result.members : [];
    if (members.length === 0 && memberOffset === 0) {
      appendText(
        content,
        "p",
        memberText("member.empty"),
        "oc-state oc-state--empty",
      );
      return;
    }
    const tableWrapper = document.createElement("div");
    tableWrapper.className = "oc-table-wrap";
    const table = document.createElement("table");
    table.className = "oc-table";
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of [
      memberText("member.name"),
      memberText("member.email"),
      memberText("member.status"),
      memberText("member.added"),
      memberText("member.roles"),
      memberText("member.branchAccess"),
    ]) {
      const header = appendText(headerRow, "th", label);
      header.scope = "col";
    }
    head.append(headerRow);
    const body = document.createElement("tbody");
    for (const member of members) {
      const row = document.createElement("tr");
      for (const value of [
        member.displayName,
        member.email,
        member.status,
        formatDateTime(new Date(member.createdAt), {
          locale: preferenceLocale,
        }),
      ]) {
        appendText(row, "td", String(value ?? "—"));
      }
      const rolesCell = document.createElement("td");
      const disclosure = document.createElement("details");
      disclosure.className = "oc-dropdown";
      const summary = appendText(
        disclosure,
        "summary",
        memberText("member.manageRoles"),
      );
      summary.setAttribute(
        "aria-label",
        `${memberText("member.manageRoles")}: ${member.displayName}`,
      );
      const panel = document.createElement("div");
      panel.className = "oc-stack";
      panel.setAttribute("aria-live", "polite");
      disclosure.append(panel);
      disclosure.addEventListener("toggle", () => {
        if (!disclosure.open || disclosure.dataset.loaded === "true") return;
        disclosure.dataset.loaded = "true";
        void loadMemberRolePanel(panel, organizationId, member, session);
      });
      rolesCell.append(disclosure);
      const branchesCell = document.createElement("td");
      const branchDisclosure = document.createElement("details");
      branchDisclosure.className = "oc-dropdown";
      const branchSummary = appendText(
        branchDisclosure,
        "summary",
        memberText("member.manageBranches"),
      );
      branchSummary.setAttribute(
        "aria-label",
        `${memberText("member.manageBranches")}: ${member.displayName}`,
      );
      const branchPanel = document.createElement("div");
      branchPanel.className = "oc-stack";
      branchPanel.setAttribute("aria-live", "polite");
      branchDisclosure.append(branchPanel);
      branchDisclosure.addEventListener("toggle", () => {
        if (
          !branchDisclosure.open ||
          branchDisclosure.dataset.loaded === "true"
        ) {
          return;
        }
        branchDisclosure.dataset.loaded = "true";
        void loadMemberBranchPanel(
          branchPanel,
          organizationId,
          member,
          session,
        );
      });
      branchesCell.append(branchDisclosure);
      row.append(rolesCell, branchesCell);
      body.append(row);
    }
    table.append(head, body);
    tableWrapper.append(table);
    content.append(tableWrapper);
    const pagination = document.createElement("nav");
    pagination.className = "oc-pagination";
    pagination.setAttribute("aria-label", memberText("member.pages"));
    const controls = document.createElement("div");
    controls.className = "oc-pagination__controls";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "oc-button oc-button--secondary";
    previous.textContent = memberText("member.previous");
    previous.disabled = memberOffset === 0;
    previous.addEventListener("click", () => {
      memberOffset = Math.max(0, memberOffset - 20);
      void loadMembersView(content);
    });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "oc-button oc-button--secondary";
    next.textContent = memberText("member.next");
    next.disabled = !result.hasMore;
    next.addEventListener("click", () => {
      memberOffset += 20;
      void loadMembersView(content);
    });
    controls.append(previous, next);
    pagination.append(controls);
    content.append(pagination);
  } catch (requestError) {
    if (sequence !== memberLoadSequence || currentSession !== session) return;
    content.replaceChildren();
    const error = appendText(
      content,
      "div",
      requestError instanceof ApiError && requestError.status === 403
        ? memberText("member.accessDenied")
        : errorMessage(requestError),
      "oc-alert oc-alert--error",
    );
    error.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "oc-button oc-button--secondary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void loadMembersView(content));
    content.append(retry);
  }
}

async function loadMemberRolePanel(
  panel,
  organizationId,
  member,
  session,
  statusMessage,
) {
  panel.replaceChildren();
  const loading = appendText(
    panel,
    "p",
    memberText("member.rolesLoading"),
    "oc-state oc-state--loading",
  );
  loading.setAttribute("role", "status");
  try {
    const result = await authenticatedRequest(
      `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(member.id)}/roles`,
    );
    if (currentSession !== session || !panel.isConnected) return;
    panel.replaceChildren();
    if (statusMessage) {
      const status = appendText(panel, "p", statusMessage, "oc-muted");
      status.setAttribute("role", "status");
    }
    appendText(panel, "h3", memberText("member.assignedRoles"));
    const assignedRoles = Array.isArray(result.assignedRoles)
      ? result.assignedRoles
      : [];
    if (assignedRoles.length === 0) {
      appendText(panel, "p", memberText("member.noAssignedRoles"), "oc-muted");
    } else {
      for (const role of assignedRoles) {
        const item = document.createElement("div");
        item.className = "oc-pagination__controls";
        const status =
          role.status === "ACTIVE"
            ? role.name
            : `${role.name} (${memberText("member.inactiveRole")})`;
        appendText(item, "span", status);
        if (result.capabilities?.canRemove === true) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "oc-button oc-button--secondary";
          remove.textContent = memberText("member.removeRole");
          remove.addEventListener("click", async () => {
            if (!window.confirm(memberText("member.confirmRoleRemoval"))) return;
            remove.disabled = true;
            try {
              await authenticatedRequest(
                `/auth/membership/roles/${encodeURIComponent(member.id)}/${encodeURIComponent(role.id)}`,
                { method: "DELETE" },
              );
              await loadMemberRolePanel(
                panel,
                organizationId,
                member,
                session,
                memberText("member.roleUpdated"),
              );
            } catch (requestError) {
              remove.disabled = false;
              appendText(
                panel,
                "p",
                errorMessage(requestError),
                "oc-alert oc-alert--error",
              );
            }
          });
          item.append(remove);
        }
        panel.append(item);
      }
    }

    const availableRoles = Array.isArray(result.availableRoles)
      ? result.availableRoles.filter(
          (role) => !assignedRoles.some((assigned) => assigned.id === role.id),
        )
      : [];
    if (member.status === "ACTIVE" && result.capabilities?.canAssign === true) {
      appendText(panel, "h3", memberText("member.availableRoles"));
      if (availableRoles.length === 0) {
        appendText(
          panel,
          "p",
          memberText("member.noAvailableRoles"),
          "oc-muted",
        );
      } else {
        const form = document.createElement("form");
        form.className = "oc-stack";
        const select = document.createElement("select");
        select.required = true;
        select.setAttribute("aria-label", memberText("member.availableRoles"));
        for (const role of availableRoles) {
          const option = document.createElement("option");
          option.value = role.id;
          option.textContent = role.name;
          select.append(option);
        }
        const assign = document.createElement("button");
        assign.type = "submit";
        assign.className = "oc-button oc-button--secondary";
        assign.textContent = memberText("member.assignRole");
        form.append(select, assign);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          assign.disabled = true;
          try {
            await authenticatedRequest("/auth/membership/roles", {
              method: "POST",
              body: { membershipId: member.id, roleId: select.value },
            });
            await loadMemberRolePanel(
              panel,
              organizationId,
              member,
              session,
              memberText("member.roleUpdated"),
            );
          } catch (requestError) {
            assign.disabled = false;
            appendText(
              panel,
              "p",
              errorMessage(requestError),
              "oc-alert oc-alert--error",
            );
          }
        });
        panel.append(form);
      }
    }
  } catch (requestError) {
    if (currentSession !== session || !panel.isConnected) return;
    panel.replaceChildren();
    const error = appendText(
      panel,
      "p",
      requestError instanceof ApiError && requestError.status === 403
        ? memberText("member.rolesAccessDenied")
        : errorMessage(requestError),
      "oc-alert oc-alert--error",
    );
    error.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "oc-button oc-button--secondary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void loadMemberRolePanel(panel, organizationId, member, session);
    });
    panel.append(retry);
  }
}

async function loadMemberBranchPanel(
  panel,
  organizationId,
  member,
  session,
  statusMessage,
) {
  panel.replaceChildren();
  const loading = appendText(
    panel,
    "p",
    memberText("member.branchesLoading"),
    "oc-state oc-state--loading",
  );
  loading.setAttribute("role", "status");
  try {
    const result = await authenticatedRequest(
      `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(member.id)}/branches`,
    );
    if (currentSession !== session || !panel.isConnected) return;
    panel.replaceChildren();
    if (statusMessage) {
      const status = appendText(panel, "p", statusMessage, "oc-muted");
      status.setAttribute("role", "status");
    }
    appendText(
      panel,
      "p",
      `${memberText("member.branchMode")}: ${result.branchAccessMode}`,
      "oc-muted",
    );
    if (result.branchAccessMode === "ALL") {
      const allBranches = Array.isArray(result.effectiveAccess?.branches)
        ? result.effectiveAccess.branches
        : [];
      if (allBranches.length === 0) {
        appendText(panel, "p", memberText("branch.empty"), "oc-muted");
      } else {
        appendText(panel, "h4", memberText("member.allBranches"));
        renderSimpleTable(
          panel,
          [memberText("member.name"), memberText("member.status")],
          allBranches.map((branch) => [branch.name, branch.status]),
        );
      }
      appendText(panel, "p", memberText("member.allModeReadOnly"), "oc-help");
      return;
    }

    const assignments = Array.isArray(result.explicitAssignments)
      ? result.explicitAssignments
      : [];
    appendText(panel, "h4", memberText("member.assignedBranches"));
    if (assignments.length === 0) {
      appendText(
        panel,
        "p",
        memberText("member.noAssignedBranches"),
        "oc-muted",
      );
    } else {
      for (const branch of assignments) {
        const item = document.createElement("div");
        item.className = "oc-pagination__controls";
        const branchStatus =
          branch.status === "ACTIVE"
            ? branch.name
            : `${branch.name} (${branchText("branch.status.inactive")})`;
        appendText(item, "span", branchStatus);
        if (
          result.capabilities?.canRemove === true &&
          member.status === "ACTIVE"
        ) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "oc-button oc-button--secondary";
          remove.textContent = memberText("member.removeBranch");
          remove.addEventListener("click", async () => {
            if (!window.confirm(memberText("member.confirmBranchRemoval")))
              return;
            remove.disabled = true;
            try {
              await authenticatedRequest(
                `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(member.id)}/branches/${encodeURIComponent(branch.id)}`,
                { method: "DELETE" },
              );
              await loadMemberBranchPanel(
                panel,
                organizationId,
                member,
                session,
                memberText("member.branchUpdated"),
              );
            } catch (requestError) {
              remove.disabled = false;
              appendText(
                panel,
                "p",
                errorMessage(requestError),
                "oc-alert oc-alert--error",
              );
            }
          });
          item.append(remove);
        }
        panel.append(item);
      }
    }

    if (member.status !== "ACTIVE") return;
    const activeBranches = Array.isArray(result.availableBranches)
      ? result.availableBranches
      : [];
    const assignedIds = new Set(assignments.map((branch) => branch.id));
    const candidates = activeBranches.filter(
      (branch) => !assignedIds.has(branch.id),
    );
    if (result.capabilities?.canAssign !== true || candidates.length === 0) {
      if (result.capabilities?.canAssign === true) {
        appendText(
          panel,
          "p",
          memberText("member.noAvailableBranches"),
          "oc-muted",
        );
      }
      return;
    }
    appendText(panel, "h4", memberText("member.availableBranches"));
    const form = document.createElement("form");
    form.className = "oc-stack";
    const field = document.createElement("div");
    field.className = "oc-field";
    const label = document.createElement("label");
    label.htmlFor = `member-${member.id}-branch-assignment`;
    label.textContent = memberText("member.availableBranches");
    const select = document.createElement("select");
    select.id = label.htmlFor;
    select.className = "oc-input";
    select.required = true;
    for (const branch of candidates) {
      const option = document.createElement("option");
      option.value = branch.id;
      option.textContent = `${branch.name} (${branch.code})`;
      select.append(option);
    }
    field.append(label, select);
    const assign = document.createElement("button");
    assign.type = "submit";
    assign.className = "oc-button oc-button--secondary";
    assign.textContent = memberText("member.assignBranch");
    form.append(field, assign);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!select.value) return;
      assign.disabled = true;
      try {
        await authenticatedRequest(
          `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(member.id)}/branches`,
          { method: "POST", body: { branchIds: [select.value] } },
        );
        await loadMemberBranchPanel(
          panel,
          organizationId,
          member,
          session,
          memberText("member.branchUpdated"),
        );
      } catch (requestError) {
        assign.disabled = false;
        appendText(
          panel,
          "p",
          errorMessage(requestError),
          "oc-alert oc-alert--error",
        );
      }
    });
    panel.append(form);
  } catch (requestError) {
    if (currentSession !== session || !panel.isConnected) return;
    panel.replaceChildren();
    const error = appendText(
      panel,
      "p",
      requestError instanceof ApiError && requestError.status === 403
        ? memberText("member.branchesAccessDenied")
        : errorMessage(requestError),
      "oc-alert oc-alert--error",
    );
    error.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "oc-button oc-button--secondary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void loadMemberBranchPanel(panel, organizationId, member, session);
    });
    panel.append(retry);
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
  resetPosWorkspaceState();
  if (globalSearchDialog.open) globalSearchDialog.close();
  businessResourceContext = "";
  businessResourceOffsets.customers = 0;
  businessResourceOffsets.products = 0;
  businessResourceFilters.customers = {};
  businessResourceFilters.products = {};
  const content = document.querySelector("#boundary-content");
  content.replaceChildren();
  if (["customers", "products", "pos"].includes(location.hash.slice(1))) {
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
  } else if (view === "pos") {
    void loadPosWorkspace(document.querySelector("#boundary-content"));
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

function resetPosWorkspaceState({ clearCart = true } = {}) {
  posLoadSequence += 1;
  posContext = "";
  posSearch = "";
  posOffset = 0;
  if (clearCart) {
    posCart.clear();
    posCheckoutNotice = null;
    posSaleConfirmation = null;
  }
}

function posCatalogEndpoint(organizationId) {
  return `/organizations/${encodeURIComponent(organizationId)}/business/catalog`;
}

function posCheckoutContext(session = currentSession) {
  return {
    organizationId: session?.organization?.organizationId ?? "",
    userId: session?.user?.id ?? "",
    branchId: session?.branch?.branchId ?? null,
  };
}

function posCatalogItemIsValid(item) {
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.unit !== "string" ||
    typeof item.currency !== "string" ||
    !/^[A-Z]{3}$/.test(item.currency) ||
    (item.type !== "PRODUCT" && item.type !== "SERVICE") ||
    item.status !== "ACTIVE" ||
    (item.reference !== null && typeof item.reference !== "string") ||
    typeof item.price !== "string"
  ) {
    return false;
  }
  catalogPriceToScaledAmount(item.price);
  return true;
}

function renderPosCart(container) {
  container.replaceChildren();
  const context = posCheckoutContext();
  const attemptState = posCheckoutController.getState(context);
  const locked =
    posCheckoutSubmitting ||
    ["PENDING", "UNCERTAIN", "CONFLICT", "OTHER_CONTEXT", "INVALID"].includes(
      attemptState.kind,
    );
  appendText(container, "h2", "Draft cart", "oc-section-title");
  appendText(
    container,
    "p",
    "A local draft until checkout is confirmed. No payment is collected.",
    "oc-help",
  );
  if (posCheckoutSubmitting) {
    appendText(
      container,
      "p",
      "Submitting checkout…",
      "oc-state oc-state--loading",
    ).setAttribute("role", "status");
  } else if (
    attemptState.kind === "PENDING" ||
    attemptState.kind === "UNCERTAIN"
  ) {
    appendText(
      container,
      "p",
      `An attempt for ${attemptState.attempt.request.lines.length} catalog item(s) is not confirmed. Retry the exact same checkout attempt.`,
      "oc-alert",
    ).setAttribute("role", "status");
  } else if (attemptState.kind === "CONFLICT") {
    appendText(
      container,
      "p",
      saleCheckoutMessage({ kind: "CONFLICT" }),
      "oc-alert oc-alert--error",
    ).setAttribute("role", "alert");
  } else if (attemptState.kind === "OTHER_CONTEXT") {
    appendText(
      container,
      "p",
      saleCheckoutMessage({ kind: "OTHER_CONTEXT" }),
      "oc-alert oc-alert--error",
    ).setAttribute("role", "alert");
  } else if (attemptState.kind === "INVALID") {
    appendText(
      container,
      "p",
      saleCheckoutMessage({ kind: "INVALID" }),
      "oc-alert oc-alert--error",
    ).setAttribute("role", "alert");
  } else if (attemptState.kind === "STORAGE_ERROR") {
    appendText(
      container,
      "p",
      saleCheckoutMessage({ kind: "STORAGE_ERROR" }),
      "oc-alert oc-alert--error",
    ).setAttribute("role", "alert");
  }
  if (posCheckoutNotice) {
    const notice = appendText(
      container,
      "p",
      posCheckoutNotice.message,
      posCheckoutNotice.error ? "oc-alert oc-alert--error" : "oc-alert",
    );
    notice.setAttribute("role", posCheckoutNotice.error ? "alert" : "status");
  }
  if (posSaleConfirmation) {
    const confirmation = document.createElement("section");
    confirmation.className = "oc-alert";
    confirmation.setAttribute("role", "status");
    appendText(confirmation, "h3", "Unpaid — OPEN", "oc-section-title");
    appendText(confirmation, "p", `Sale ID: ${posSaleConfirmation.id}`);
    appendText(
      confirmation,
      "p",
      `Server total: ${posSaleConfirmation.total} ${posSaleConfirmation.currency}`,
    );
    const serverLines = document.createElement("ul");
    for (const line of posSaleConfirmation.lines) {
      appendText(
        serverLines,
        "li",
        `${line.itemName}: ${line.unitPrice} ${posSaleConfirmation.currency} × ${line.quantity} = ${line.lineTotal} ${posSaleConfirmation.currency}`,
      );
    }
    confirmation.append(serverLines);
    container.append(confirmation);
  }
  if (posCart.size === 0) {
    appendText(container, "p", "No items in your draft cart yet.", "oc-muted");
    if (attemptState.attempt) {
      appendText(
        container,
        "p",
        "The saved request contains catalog item IDs and quantities only; server pricing will be shown after confirmation.",
        "oc-help",
      );
    }
  } else {
    const list = document.createElement("div");
    list.className = "oc-stack";
    for (const item of posCart.values()) {
      const row = document.createElement("article");
      row.className = "oc-pos-cart-item";
      const heading = document.createElement("div");
      heading.className = "oc-cluster";
      appendText(heading, "strong", item.name);
      appendText(
        heading,
        "span",
        `${item.price} ${item.currency} / ${item.unit}`,
        "oc-muted",
      );
      row.append(heading);

      const controls = document.createElement("div");
      controls.className = "oc-pos-cart-controls";
      const field = document.createElement("div");
      field.className = "oc-field";
      const quantityId = `pos-quantity-${list.childElementCount}`;
      const label = document.createElement("label");
      label.htmlFor = quantityId;
      label.textContent = "Quantity";
      const quantity = document.createElement("input");
      quantity.id = quantityId;
      quantity.className = "oc-input";
      quantity.type = "number";
      quantity.min = "1";
      quantity.max = "1000000";
      quantity.step = "1";
      quantity.required = true;
      quantity.value = String(item.quantity);
      quantity.inputMode = "numeric";
      quantity.disabled = locked;
      quantity.addEventListener("change", () => {
        if (locked) return;
        if (setDraftCartQuantity(posCart, item.id, quantity.value)) {
          renderPosCart(container);
        } else {
          quantity.value = String(item.quantity);
          announce("Enter a whole-number quantity greater than zero.", "error");
        }
      });
      field.append(label, quantity);
      const lineAmount =
        catalogPriceToScaledAmount(item.price) * BigInt(item.quantity);
      appendText(
        controls,
        "span",
        `Line estimate: ${formatScaledAmount(lineAmount)} ${item.currency}`,
        "oc-muted",
      );
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "oc-button oc-button--secondary";
      remove.textContent = "Remove";
      remove.disabled = locked;
      remove.setAttribute("aria-label", `Remove ${item.name} from draft`);
      remove.addEventListener("click", () => {
        if (locked) return;
        removeDraftCartItem(posCart, item.id);
        renderPosCart(container);
      });
      controls.prepend(field);
      controls.append(remove);
      row.append(controls);
      list.append(row);
    }
    container.append(list);

    const subtotal = draftCartSubtotal(posCart);
    if (subtotal) {
      appendText(
        container,
        "p",
        `Catalog subtotal estimate: ${formatScaledAmount(subtotal.amount)} ${subtotal.currency}`,
        "oc-pos-subtotal",
      );
    }
  }
  appendText(
    container,
    "p",
    "Catalog subtotal estimate only. No tax or discounts are calculated; the server determines the sale total.",
    "oc-help",
  );
  const matchingAttempt =
    (attemptState.kind === "PENDING" || attemptState.kind === "UNCERTAIN") &&
    attemptState.attempt;
  const canStartCheckout = attemptState.kind === "NONE" && posCart.size > 0;
  if (matchingAttempt || canStartCheckout) {
    const checkout = document.createElement("button");
    checkout.type = "button";
    checkout.className = "oc-button";
    checkout.textContent = matchingAttempt
      ? "Retry same checkout"
      : "Create unpaid sale";
    checkout.disabled =
      posCheckoutSubmitting ||
      !context.organizationId ||
      !context.branchId ||
      (matchingAttempt && attemptState.kind === "CONFLICT");
    checkout.addEventListener("click", () => {
      if (posCheckoutSubmitting || !currentSession) return;
      void submitPosCheckout(container, currentSession);
    });
    container.append(checkout);
    if (!context.branchId) {
      appendText(
        container,
        "p",
        "An authorized active branch is required for checkout.",
        "oc-help",
      );
    }
  }
  if (posCart.size > 0) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "oc-button oc-button--quiet";
    clear.textContent = "Clear draft";
    clear.disabled = locked;
    clear.addEventListener("click", () => {
      if (locked) return;
      posCart.clear();
      renderPosCart(container);
    });
    container.append(clear);
  }
}

async function submitPosCheckout(container, session) {
  if (posCheckoutSubmitting) return;
  posCheckoutSubmitting = true;
  const context = posCheckoutContext(session);
  const productAddButtons = [
    ...(container
      .closest(".oc-pos-layout")
      ?.querySelectorAll(".oc-pos-product button") ?? []),
  ];
  productAddButtons.forEach((button) => {
    button.disabled = true;
  });
  const contextSelectors = [organizationSelect, branchSelect].filter(Boolean);
  const priorDisabledState = contextSelectors.map(
    (selector) => selector.disabled,
  );
  contextSelectors.forEach((selector) => {
    selector.disabled = true;
  });
  posCheckoutNotice = { message: "Submitting checkout…", error: false };
  renderPosCart(container);
  let result;
  try {
    result = await posCheckoutController.submit(posCart, context);
  } catch {
    result = { kind: "UNCERTAIN", reason: "REQUEST_FAILED" };
  } finally {
    posCheckoutSubmitting = false;
    contextSelectors.forEach((selector, index) => {
      selector.disabled = priorDisabledState[index];
    });
  }
  if (result.kind === "SUCCESS") {
    if (currentSession === session) {
      posCart.clear();
      posSaleConfirmation = result.sale;
      posCheckoutNotice = null;
    }
    announce("Sale confirmed. Unpaid — OPEN.", "success");
  } else {
    posCheckoutNotice = {
      message: saleCheckoutMessage(result),
      error: result.kind !== "IN_PROGRESS",
    };
  }
  if (currentSession === session) {
    const state = posCheckoutController.getState(context);
    const locked = [
      "PENDING",
      "UNCERTAIN",
      "CONFLICT",
      "OTHER_CONTEXT",
      "INVALID",
    ].includes(state.kind);
    const currency = posCart.values().next().value?.currency;
    productAddButtons.forEach((button) => {
      button.disabled =
        locked || (currency && currency !== button.dataset.currency);
    });
    renderPosCart(container);
  }
}

function renderPosWorkspace(container, response, session, search, offset) {
  if (
    !Array.isArray(response.items) ||
    !Number.isSafeInteger(response.total) ||
    response.total < 0 ||
    !response.items.every(posCatalogItemIsValid)
  ) {
    throw new TypeError("The catalog response is not valid for POS display.");
  }

  const selectedBranch = session.availableBranches.find(
    (branch) => branch.branchId === session.branch?.branchId,
  );
  const checkoutState = posCheckoutController.getState(
    posCheckoutContext(session),
  );
  const checkoutLocked =
    posCheckoutSubmitting ||
    ["PENDING", "UNCERTAIN", "CONFLICT", "OTHER_CONTEXT", "INVALID"].includes(
      checkoutState.kind,
    );
  const workspace = document.createElement("div");
  workspace.className = "oc-pos-layout";
  const catalog = document.createElement("section");
  catalog.className = "oc-card oc-stack";
  catalog.setAttribute("aria-label", "Active catalog items");
  const context = appendText(
    catalog,
    "p",
    `Selling context: ${session.organization.name} · ${selectedBranch?.name ?? "Organization-wide access"}`,
    "oc-pos-context",
  );
  context.setAttribute("aria-label", "Selected organization and branch");

  const searchForm = document.createElement("form");
  searchForm.className = "oc-pos-search";
  const searchField = document.createElement("div");
  searchField.className = "oc-field";
  const searchLabel = document.createElement("label");
  searchLabel.htmlFor = "pos-catalog-search";
  searchLabel.textContent = "Search catalog";
  const searchInput = document.createElement("input");
  searchInput.id = "pos-catalog-search";
  searchInput.className = "oc-input";
  searchInput.type = "search";
  searchInput.name = "search";
  searchInput.maxLength = 100;
  searchInput.autocomplete = "off";
  searchInput.placeholder = "Name or SKU/reference";
  searchInput.value = search;
  searchField.append(searchLabel, searchInput);
  const searchButton = document.createElement("button");
  searchButton.type = "submit";
  searchButton.className = "oc-button";
  searchButton.textContent = "Search";
  searchForm.append(searchField, searchButton);
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!searchForm.reportValidity()) return;
    void loadPosWorkspace(container, {
      search: searchInput.value.trim(),
      offset: 0,
    });
  });
  catalog.append(searchForm);

  appendText(
    catalog,
    "p",
    "Prices below are active catalog values. Stock availability is not provided by this API.",
    "oc-help",
  );
  const products = document.createElement("div");
  products.className = "oc-pos-products";
  if (response.items.length === 0) {
    appendText(
      products,
      "p",
      search
        ? "No active catalog items match this search."
        : "No active catalog items are available.",
      "oc-state oc-state--empty",
    );
  } else {
    for (const item of response.items) {
      const card = document.createElement("article");
      card.className = "oc-pos-product";
      const heading = document.createElement("div");
      heading.className = "oc-cluster";
      appendText(heading, "h3", item.name, "oc-section-title");
      heading.append(createStatusBadge(item.type, "neutral"));
      card.append(heading);
      if (item.reference) {
        appendText(card, "p", `SKU/reference: ${item.reference}`, "oc-muted");
      }
      appendText(
        card,
        "p",
        `${item.price} ${item.currency} / ${item.unit}`,
        "oc-pos-price",
      );
      const cartCurrency = posCart.values().next().value?.currency;
      const currencyMismatch =
        Boolean(cartCurrency) && cartCurrency !== item.currency;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "oc-button oc-button--secondary";
      add.textContent = "Add to draft";
      add.dataset.currency = item.currency;
      add.disabled = currencyMismatch || checkoutLocked;
      if (currencyMismatch) {
        appendText(
          card,
          "p",
          `Clear the ${cartCurrency} draft before adding ${item.currency} items.`,
          "oc-help",
        );
      }
      add.addEventListener("click", () => {
        const state = posCheckoutController.getState(
          posCheckoutContext(session),
        );
        if (
          posCheckoutSubmitting ||
          !["NONE", "STORAGE_ERROR"].includes(state.kind)
        ) {
          return;
        }
        if (!addDraftCartItem(posCart, item)) {
          announce(
            "This draft uses another currency. Clear it before adding this item.",
            "error",
          );
          return;
        }
        renderPosCart(cartPanel);
        announce(`${item.name} added to the draft cart. No sale was created.`);
      });
      card.append(add);
      products.append(card);
    }
  }
  catalog.append(products);

  if (response.total > 24) {
    const pagination = document.createElement("nav");
    pagination.className = "oc-pagination";
    pagination.setAttribute("aria-label", "POS catalog pages");
    const summary = appendText(
      pagination,
      "span",
      `Showing ${offset + 1}–${offset + response.items.length} of ${response.total}`,
      "oc-muted",
    );
    summary.setAttribute("aria-live", "polite");
    const controls = document.createElement("div");
    controls.className = "oc-pagination__controls";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "oc-button oc-button--secondary";
    previous.textContent = "Previous";
    previous.disabled = offset === 0;
    previous.addEventListener("click", () => {
      void loadPosWorkspace(container, {
        search,
        offset: Math.max(0, offset - 24),
      });
    });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "oc-button oc-button--secondary";
    next.textContent = "Next";
    next.disabled = offset + response.items.length >= response.total;
    next.addEventListener("click", () => {
      void loadPosWorkspace(container, { search, offset: offset + 24 });
    });
    controls.append(previous, next);
    pagination.append(controls);
    catalog.append(pagination);
  }

  const cartPanel = document.createElement("aside");
  cartPanel.className = "oc-card oc-stack oc-pos-cart";
  cartPanel.setAttribute("aria-label", "Draft cart");
  workspace.append(catalog, cartPanel);
  container.replaceChildren(workspace);
  renderPosCart(cartPanel);
}

async function loadPosWorkspace(
  container,
  { search = posSearch, offset = posOffset } = {},
) {
  const session = currentSession;
  const organizationId = session?.organization?.organizationId;
  const context = `${organizationId ?? ""}:${session?.branch?.branchId ?? ""}`;
  if (context !== posContext) {
    posCart.clear();
    posContext = context;
    posSearch = "";
    posOffset = 0;
    search = "";
    offset = 0;
  }
  posSearch = search;
  posOffset = offset;
  const sequence = ++posLoadSequence;
  container.replaceChildren();
  if (!organizationId) {
    appendText(
      container,
      "p",
      "Select an organization to browse its active catalog.",
      "oc-state oc-state--empty",
    );
    return;
  }
  appendText(
    container,
    "p",
    "Loading active catalog items…",
    "oc-state oc-state--loading",
  ).setAttribute("role", "status");
  const params = new globalThis.URLSearchParams({
    status: "ACTIVE",
    limit: "24",
    offset: String(offset),
  });
  if (search) params.set("search", search);
  try {
    const response = await authenticatedRequest(
      `${posCatalogEndpoint(organizationId)}?${params}`,
    );
    if (sequence !== posLoadSequence || currentSession !== session) return;
    renderPosWorkspace(container, response, session, search, offset);
  } catch (requestError) {
    if (sequence !== posLoadSequence || currentSession !== session) return;
    container.replaceChildren();
    const error = appendText(
      container,
      "p",
      requestError instanceof ApiError && requestError.status === 403
        ? "You are not authorized to browse the catalog for this organization and branch."
        : errorMessage(requestError),
      "oc-alert oc-alert--error",
    );
    error.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "oc-button oc-button--secondary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void loadPosWorkspace(container, { search, offset });
    });
    container.append(retry);
  }
}

function businessField(
  form,
  {
    name,
    label,
    type = "text",
    value,
    required,
    maxLength,
    options,
    pattern,
    title,
  },
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
  if (pattern) input.pattern = pattern;
  if (title) input.title = title;
  if (type === "email") input.autocomplete = "email";
  if (type === "tel") input.autocomplete = "tel";
  if (name === "price") input.inputMode = "decimal";
  if (name === "currency") {
    input.maxLength = 3;
    input.addEventListener("input", () => input.setCustomValidity(""));
  }
  input.value = value ?? "";
  field.append(labelElement, input);
  form.append(field);
  return input;
}

function renderBusinessTable(view, items, container, handlers, capabilities) {
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
    actions.append(viewButton);
    if (capabilities.canUpdate === true) {
      const editButton = document.createElement("button");
      editButton.className = "oc-button oc-button--quiet";
      editButton.type = "button";
      editButton.textContent = "Edit";
      editButton.setAttribute("aria-label", `Edit ${item.name}`);
      editButton.addEventListener("click", () => void handlers.edit(item.id));
      actions.append(editButton);
    }
    if (capabilities.canDelete === true && item.status === "ACTIVE") {
      const deleteButton = document.createElement("button");
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
        ["CURRENT", "Current branch and organization-wide"],
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
      pattern: "(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?",
      title: "Enter a non-negative price with up to six decimal places.",
    });
    businessField(form, {
      name: "currency",
      label: "Currency (ISO 4217)",
      value: item?.currency,
      required: true,
      maxLength: 3,
      pattern: "[A-Z]{3}",
      title: "Enter a supported uppercase ISO 4217 currency code.",
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
    const capabilities = response.capabilities ?? {};
    if (capabilities.canCreate === true) {
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
      content.prepend(heading);
    }
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
      }, capabilities);
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
      "pos-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/business/catalog?status=ACTIVE&limit=1`,
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
    [
      "members-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/members?limit=1`,
    ],
    [
      "branches-nav",
      organizationId &&
        `/organizations/${encodeURIComponent(organizationId)}/branches?limit=1`,
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
  document.querySelector("#members-nav").textContent = memberText("member.nav");
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
  currentSession = session;
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
