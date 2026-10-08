import { ApiError, createApiClient } from "../../packages/ui/src/api-client.js";
import { createStatusBadge } from "../../packages/ui/src/elements.js";

const apiBase =
  document
    .querySelector('meta[name="onecore-api-base"]')
    ?.getAttribute("content") ?? "";
const api = createApiClient(apiBase);
const checkingView = document.querySelector("#checking-view");
const loginView = document.querySelector("#login-view");
const accessView = document.querySelector("#access-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const requestsMessage = document.querySelector("#requests-message");
const requestList = document.querySelector("#request-list");
const requestDetail = document.querySelector("#request-detail");
const appMessage = document.querySelector("#app-message");
const requests = [];
let selectedReference = null;
let activeFilter = "ALL";
let requestSequence = 0;

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined && text !== null) item.textContent = String(text);
  if (className) item.className = className;
  return item;
}

function setAlert(target, message, kind = "info") {
  target.hidden = !message;
  target.className = kind === "error" ? "oc-alert oc-alert--error" : "oc-alert";
  target.textContent = message;
}

function showOnly(view) {
  for (const candidate of [checkingView, loginView, accessView, appView]) {
    candidate.hidden = candidate !== view;
  }
}

function statusVariant(status) {
  if (status === "APPROVED") return "success";
  if (status === "REJECTED") return "danger";
  if (status === "UNDER_REVIEW") return "info";
  return "warning";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function updateCounts() {
  const counts = {
    PENDING: 0,
    UNDER_REVIEW: 0,
    APPROVED: 0,
    REJECTED: 0,
  };
  for (const application of requests) {
    if (application.status in counts) counts[application.status] += 1;
  }
  for (const [status, count] of Object.entries(counts)) {
    document.querySelector(
      `#count-${status.toLowerCase().replaceAll("_", "-")}`,
    ).textContent = String(count);
    document.querySelector(
      `#filter-count-${status.toLowerCase().replaceAll("_", "-")}`,
    ).textContent = String(count);
  }
  document.querySelector("#filter-count-all").textContent = String(
    requests.length,
  );
  const pendingCount = document.querySelector("#pending-nav-count");
  pendingCount.textContent = String(counts.PENDING);
  pendingCount.hidden = counts.PENDING === 0;
}

function renderList() {
  requestList.replaceChildren();
  const visible = requests.filter(
    (application) =>
      activeFilter === "ALL" || application.status === activeFilter,
  );
  if (visible.length === 0) {
    requestList.append(
      element(
        "p",
        activeFilter === "ALL"
          ? "No organization account requests have been submitted."
          : `No ${activeFilter.toLowerCase().replaceAll("_", " ")} requests.`,
        "oc-state oc-state--empty",
      ),
    );
    return;
  }

  const table = document.createElement("table");
  table.className = "oc-table";
  table.innerHTML =
    '<thead><tr><th scope="col">Organization</th><th scope="col">Industry</th><th scope="col">Submitted</th><th scope="col">Status</th><th scope="col"><span class="oc-sr-only">Action</span></th></tr></thead>';
  const body = document.createElement("tbody");
  for (const application of visible) {
    const row = document.createElement("tr");
    row.append(
      element("td", application.organization.name),
      element("td", application.organization.industry),
      element("td", formatDate(application.submittedAt)),
    );
    const statusCell = document.createElement("td");
    statusCell.append(
      createStatusBadge(
        application.status.replaceAll("_", " "),
        statusVariant(application.status),
      ),
    );
    row.append(statusCell);
    const actionCell = document.createElement("td");
    const view = element("button", "Review", "oc-button oc-button--secondary");
    view.type = "button";
    view.setAttribute("aria-label", `Review ${application.organization.name}`);
    view.addEventListener("click", () => showDetail(application.reference));
    actionCell.append(view);
    row.append(actionCell);
    body.append(row);
  }
  table.append(body);
  const wrapper = element("div", undefined, "oc-table-wrap");
  wrapper.append(table);
  requestList.append(wrapper);
}

function detailField(list, label, value) {
  list.append(element("dt", label, "oc-label"));
  list.append(element("dd", value || "Not provided"));
}

function showDetail(reference) {
  const application = requests.find((item) => item.reference === reference);
  if (!application) return;
  selectedReference = reference;
  const { organization, applicant } = application;
  requestDetail.replaceChildren();
  const badge = createStatusBadge(
    application.status.replaceAll("_", " "),
    statusVariant(application.status),
  );
  requestDetail.append(badge);
  const information = element("dl", undefined, "oc-detail-list");
  for (const [label, value] of [
    ["Organization", organization.name],
    ["Reference", organization.slug],
    ["Industry", organization.industry],
    ["Organization type", organization.deploymentType],
    ["Owner", applicant.ownerName],
    ["Owner email", applicant.ownerEmail],
    ["Business email", applicant.contactEmail],
    ["Business phone", applicant.contactPhone],
    ["Website", applicant.website],
    ["Country", applicant.countryCode],
    ["Region", applicant.region],
    ["City", applicant.city],
    ["Address", applicant.address],
    [
      "Requested capabilities",
      applicant.requestedModules?.join(", ") || "None",
    ],
    ["Submitted", formatDate(application.submittedAt)],
    ["Last updated", formatDate(application.updatedAt)],
  ]) {
    detailField(information, label, value);
  }
  requestDetail.append(information);
  if (application.status === "PENDING") {
    requestDetail.append(
      actionButton("Begin review", "UNDER_REVIEW", application),
    );
  } else if (application.status === "UNDER_REVIEW") {
    const actions = element("div", undefined, "oc-cluster");
    actions.append(
      actionButton("Approve", "APPROVED", application),
      actionButton(
        "Reject",
        "REJECTED",
        application,
        "oc-button oc-button--danger",
      ),
    );
    requestDetail.append(actions);
  }
}

function actionButton(label, status, application, className = "oc-button") {
  const button = element("button", label, className);
  button.type = "button";
  button.addEventListener("click", () =>
    transitionApplication(application, status, button),
  );
  return button;
}

async function transitionApplication(application, status, button) {
  const confirmation =
    status === "APPROVED"
      ? `Approve the account request for ${application.organization.name}? This records approval only; it does not activate access or create credentials.`
      : status === "REJECTED"
        ? `Reject the account request for ${application.organization.name}?`
        : `Move ${application.organization.name} into review?`;
  if (!window.confirm(confirmation)) return;

  button.disabled = true;
  setAlert(requestsMessage, "Recording review decision…");
  try {
    await api.request(
      `/platform/organization-applications/${encodeURIComponent(application.reference)}/status`,
      { method: "POST", body: { status } },
    );
    setAlert(
      requestsMessage,
      `Request status updated to ${status.replaceAll("_", " ")}.`,
    );
    await loadApplications();
  } catch (error) {
    button.disabled = false;
    const message =
      error instanceof ApiError && error.status === 403
        ? "Your account is not authorized to review organization requests."
        : error instanceof ApiError && error.status === 409
          ? "The request changed before this decision was recorded. Refresh and review it again."
          : error instanceof ApiError
            ? error.message
            : "The review decision could not be saved. Try again.";
    setAlert(requestsMessage, message, "error");
  }
}

function updateView(view) {
  const overview = document.querySelector("#overview-view");
  const requestView = document.querySelector("#requests-view");
  const showRequests = view === "requests";
  overview.hidden = showRequests;
  requestView.hidden = !showRequests;
  document.querySelector("#page-title").textContent = showRequests
    ? "Organization requests"
    : "Platform overview";
  document.querySelectorAll("[data-admin-view]").forEach((link) => {
    if (link.dataset.adminView === view)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (showRequests) renderList();
}

async function loadApplications() {
  const sequence = ++requestSequence;
  try {
    const response = await api.request("/platform/organization-applications");
    if (sequence !== requestSequence) return;
    if (!Array.isArray(response.applications)) {
      throw new ApiError(
        200,
        "INVALID_RESPONSE",
        "Invalid application response.",
      );
    }
    requests.splice(0, requests.length, ...response.applications);
    const session = await api.request("/auth/session");
    document.querySelector("#admin-name").textContent =
      session.user?.displayName || "Platform administrator";
    document.querySelector("#admin-email").textContent =
      session.user?.email || "";
    showOnly(appView);
    setAlert(appMessage, "");
    setAlert(requestsMessage, "");
    updateCounts();
    renderList();
    updateView(window.location.hash === "#requests" ? "requests" : "overview");
    if (
      selectedReference &&
      requests.some((item) => item.reference === selectedReference)
    ) {
      showDetail(selectedReference);
    } else {
      selectedReference = null;
      requestDetail.replaceChildren(
        element("p", "Select an application to review.", "oc-muted"),
      );
    }
  } catch (error) {
    if (sequence !== requestSequence) return;
    if (error instanceof ApiError && error.status === 401) {
      showOnly(loginView);
      setAlert(loginMessage, "Sign in to continue.");
      return;
    }
    if (error instanceof ApiError && error.status === 403) {
      showOnly(accessView);
      return;
    }
    showOnly(loginView);
    setAlert(
      loginMessage,
      error instanceof ApiError
        ? error.message
        : "The administration service could not be reached. Try again.",
      "error",
    );
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!loginForm.reportValidity()) return;
  const submit = document.querySelector("#login-submit");
  submit.disabled = true;
  setAlert(loginMessage, "Signing in…");
  const form = new FormData(loginForm);
  try {
    await api.request("/auth/login", {
      method: "POST",
      body: {
        email: String(form.get("email") ?? "").trim(),
        password: String(form.get("password") ?? ""),
      },
    });
    loginForm.reset();
    await loadApplications();
  } catch (error) {
    setAlert(
      loginMessage,
      error instanceof ApiError
        ? error.message
        : "Sign-in could not be completed. Try again.",
      "error",
    );
  } finally {
    submit.disabled = false;
  }
});

async function signOut() {
  try {
    await api.request("/auth/logout", { method: "POST" });
  } catch {
    // A revoked session is already signed out on the server.
  }
  loginForm.reset();
  showOnly(loginView);
  setAlert(loginMessage, "You have signed out.");
}

document
  .querySelector("#password-visibility")
  .addEventListener("click", (event) => {
    const input = document.querySelector("#login-password");
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    event.currentTarget.textContent = visible ? "Hide" : "Show";
    event.currentTarget.setAttribute(
      "aria-label",
      visible ? "Hide password" : "Show password",
    );
    event.currentTarget.setAttribute("aria-pressed", String(visible));
  });

document.querySelectorAll("[data-admin-view]").forEach((link) => {
  link.addEventListener("click", () => updateView(link.dataset.adminView));
});
window.addEventListener("hashchange", () => {
  updateView(window.location.hash === "#requests" ? "requests" : "overview");
});
document.querySelectorAll("[data-status-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.statusFilter;
    document.querySelectorAll("[data-status-filter]").forEach((candidate) => {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    });
    renderList();
  });
});
document.querySelectorAll("[data-overview-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.overviewFilter;
    document.querySelectorAll("[data-status-filter]").forEach((candidate) => {
      candidate.setAttribute(
        "aria-pressed",
        String(candidate.dataset.statusFilter === activeFilter),
      );
    });
    window.location.hash = "requests";
    updateView("requests");
  });
});
document.querySelectorAll("[data-open-requests]").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = "ALL";
    window.location.hash = "requests";
    updateView("requests");
  });
});
document
  .querySelector("#overview-refresh")
  .addEventListener("click", loadApplications);
document
  .querySelector("#requests-refresh")
  .addEventListener("click", loadApplications);
document.querySelector("#sign-out").addEventListener("click", signOut);
document.querySelector("#access-signout").addEventListener("click", signOut);

document.querySelectorAll("[data-admin-view]").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelector("#app-sidebar").removeAttribute("data-open");
    document.querySelector("#sidebar-backdrop").hidden = true;
    document
      .querySelector("#menu-toggle")
      .setAttribute("aria-expanded", "false");
  });
});
const sidebar = document.querySelector("#app-sidebar");
const backdrop = document.querySelector("#sidebar-backdrop");
const menuToggle = document.querySelector("#menu-toggle");
function closeNavigation() {
  sidebar.removeAttribute("data-open");
  backdrop.hidden = true;
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation");
  menuToggle.focus();
}

menuToggle.addEventListener("click", () => {
  const open = menuToggle.getAttribute("aria-expanded") !== "true";
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute(
    "aria-label",
    open ? "Close navigation" : "Open navigation",
  );
  sidebar.dataset.open = String(open);
  backdrop.hidden = !open;
  if (open) sidebar.querySelector("a")?.focus();
});
backdrop.addEventListener("click", closeNavigation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeNavigation();
});

void loadApplications();
