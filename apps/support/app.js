import { ApiError, createApiClient } from "../../packages/ui/src/api-client.js";
import { createMfaLoginFlow } from "../../packages/ui/src/mfa-login.js";

const apiBase =
  document
    .querySelector('meta[name="onecore-api-base"]')
    ?.getAttribute("content")
    ?.trim() ?? "";
const api = createApiClient(apiBase);
const views = {
  loading: document.querySelector("#support-loading"),
  unavailable: document.querySelector("#support-unavailable"),
  login: document.querySelector("#support-login"),
  forbidden: document.querySelector("#support-forbidden"),
  error: document.querySelector("#support-error"),
  workspace: document.querySelector("#support-workspace"),
};
const statusBadge = document.querySelector("#support-status");
const loginForm = document.querySelector("#support-login-form");
const loginMessage = document.querySelector("#support-login-message");
const supportAlert = document.querySelector("#support-alert");
const list = document.querySelector("#request-list");
const details = document.querySelector("#request-detail-content");
const pageSize = 50;
let activeSession;
let requests = [];
let currentPage = 0;
let nextPageAvailable = false;
let selectedRequestId;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function showView(view) {
  for (const candidate of Object.values(views)) {
    candidate.hidden = candidate !== view;
  }
}

function setStatus(text, variant = "warning") {
  statusBadge.textContent = text;
  statusBadge.className = `oc-badge oc-badge--${variant}`;
}

function setAlert(text, error = false) {
  supportAlert.hidden = !text;
  supportAlert.className = error ? "oc-alert oc-alert--error" : "oc-alert";
  supportAlert.textContent = text;
}

function showUnavailable(message) {
  document.querySelector("#support-unavailable-message").textContent = message;
  showView(views.unavailable);
  setStatus("Unavailable", "warning");
}

function showForbidden(message) {
  document.querySelector("#support-forbidden-message").textContent = message;
  showView(views.forbidden);
  setStatus("Access denied", "warning");
}

function showError(message) {
  document.querySelector("#support-error-message").textContent = message;
  showView(views.error);
  setStatus("Error", "danger");
}

function handleApiError(error) {
  if (error instanceof ApiError && error.status === 401) {
    activeSession = undefined;
    document.querySelector("#support-logout").hidden = true;
    showView(views.login);
    setStatus("Sign in required", "warning");
    return;
  }
  if (error instanceof ApiError && error.status === 403) {
    showForbidden(error.message);
    return;
  }
  if (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 503)
  ) {
    showUnavailable(
      "The authorized Support API is not configured or could not be reached. No customer records are shown.",
    );
    return;
  }
  showError(
    error instanceof ApiError && error.status === 0
      ? "The Support API could not be reached. Check your connection and retry."
      : error instanceof Error
        ? error.message
        : "The support request could not be completed.",
  );
}

async function loadSession() {
  if (!apiBase) {
    showUnavailable(
      "The Support API base path is not configured for this deployment.",
    );
    return;
  }
  showView(views.loading);
  try {
    activeSession = await api.request("/auth/session");
    document.querySelector("#support-logout").hidden = false;
    await populateOrganizations();
    await loadRequests(false);
  } catch (error) {
    handleApiError(error);
  }
}

async function populateOrganizations() {
  const memberships = activeSession.memberships ?? [];
  const picker = document.querySelector("#organization-picker");
  const select = document.querySelector("#organization-select");
  if (memberships.length === 0) {
    picker.hidden = true;
    return;
  }
  select.replaceChildren();
  for (const membership of memberships) {
    const option = document.createElement("option");
    option.value = membership.organizationId;
    option.textContent = membership.name;
    option.selected =
      membership.organizationId === activeSession.organization?.organizationId;
    select.append(option);
  }
  picker.hidden =
    memberships.length === 1 && Boolean(activeSession.organization);
  if (!activeSession.organization && memberships.length === 1) {
    await api.request("/auth/organization", {
      method: "POST",
      body: { organizationId: memberships[0].organizationId },
    });
    activeSession.organization = memberships[0];
  }
  document.querySelector("#request-create-form").hidden =
    !activeSession.organization;
}

async function loadRequests(append) {
  if (!append) showView(views.loading);
  setStatus("Loading", "info");
  setAlert("");
  if (!append) {
    requests = [];
    currentPage = 0;
    selectedRequestId = undefined;
    list.replaceChildren();
    details.replaceChildren();
    document.querySelector("#request-details-empty").hidden = false;
    details.hidden = true;
  }
  try {
    const result = await api.request(
      `/support/requests?page=${currentPage}&limit=${pageSize}`,
    );
    const returned = Array.isArray(result?.requests) ? result.requests : [];
    requests = append ? [...requests, ...returned] : returned;
    nextPageAvailable = result?.nextPage === currentPage + 1;
    renderRequests(append ? returned : requests);
    document.querySelector("#request-empty").hidden = requests.length > 0;
    document.querySelector("#request-next-page").hidden = !nextPageAvailable;
    document.querySelector("#request-create-form").hidden =
      !activeSession.organization;
    const context = document.querySelector("#support-context");
    context.querySelector("strong").textContent =
      activeSession.organization?.name ?? "Assigned support access";
    context.querySelectorAll("span")[1].textContent = activeSession.organization
      ? "Organization-member requests"
      : "Only requests assigned to your account";
    showView(views.workspace);
    setStatus("Connected", "success");
  } catch (error) {
    handleApiError(error);
  }
}

function renderRequests(rows) {
  for (const request of rows) {
    const item = document.createElement("li");
    const button = element("button", undefined, "oc-list-item");
    button.type = "button";
    button.setAttribute(
      "aria-current",
      String(request.id === selectedRequestId),
    );
    button.append(
      element("strong", request.subject),
      element(
        "span",
        `${request.status.replaceAll("_", " ")} · ${request.priority} · ${new Date(request.updatedAt).toLocaleString()}`,
        "oc-muted",
      ),
    );
    button.addEventListener("click", () => loadRequest(request.id));
    item.append(button);
    list.append(item);
  }
}

async function loadRequest(requestId) {
  selectedRequestId = requestId;
  try {
    const result = await api.request(
      `/support/requests/${encodeURIComponent(requestId)}`,
    );
    renderDetails(result);
    setStatus("Connected", "success");
  } catch (error) {
    handleApiError(error);
  }
}

function renderDetails(result) {
  const ticket = result.request;
  const capabilities = result.capabilities ?? {};
  document.querySelector("#request-details-empty").hidden = true;
  details.hidden = false;
  details.replaceChildren(
    element("h3", ticket.subject, "oc-section-title"),
    element(
      "p",
      `${result.organization?.name ?? "Authorized organization"} · ${ticket.status.replaceAll("_", " ")} · ${ticket.priority}`,
      "oc-muted",
    ),
  );

  const conversation = element("ol", undefined, "oc-list");
  for (const message of result.messages ?? []) {
    const item = document.createElement("li");
    item.append(
      element(
        "p",
        message.visibility === "INTERNAL" ? "Internal note" : "Reply",
        "oc-status",
      ),
      element("p", message.body),
      element(
        "small",
        new Date(message.createdAt).toLocaleString(),
        "oc-muted",
      ),
    );
    conversation.append(item);
  }
  details.append(conversation);

  details.append(createMessageForm(ticket.id, "Reply", "messages"));
  if (capabilities.internalNote) {
    details.append(createMessageForm(ticket.id, "Add internal note", "notes"));
  }
  if (capabilities.update) {
    details.append(createUpdateForm(ticket));
  }
  if (capabilities.assign) {
    details.append(createAssignmentForm(ticket.id));
  }
}

function createMessageForm(requestId, title, endpoint) {
  const form = document.createElement("form");
  form.className = "oc-stack";
  const label = element("label", title);
  const input = document.createElement("textarea");
  input.className = "oc-input";
  input.rows = 4;
  input.maxLength = 10_000;
  input.required = true;
  label.append(input);
  const button = element("button", "Send", "oc-button");
  button.type = "submit";
  form.append(label, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await api.request(
        `/support/requests/${encodeURIComponent(requestId)}/${endpoint}`,
        {
          method: "POST",
          body: { body: input.value },
        },
      );
      setAlert(endpoint === "notes" ? "Internal note added." : "Reply sent.");
      await loadRequest(requestId);
      await loadRequests(false);
    } catch (error) {
      handleApiError(error);
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

function createUpdateForm(ticket) {
  const form = document.createElement("form");
  form.className = "oc-cluster";
  const status = document.createElement("select");
  status.className = "oc-input";
  for (const value of [
    "OPEN",
    "IN_PROGRESS",
    "WAITING_ON_CUSTOMER",
    "RESOLVED",
    "CLOSED",
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value.replaceAll("_", " ");
    option.selected = ticket.status === value;
    status.append(option);
  }
  const priority = document.createElement("select");
  priority.className = "oc-input";
  for (const value of ["LOW", "NORMAL", "HIGH", "URGENT"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = ticket.priority === value;
    priority.append(option);
  }
  const button = element("button", "Update request", "oc-button");
  button.type = "submit";
  form.append(status, priority, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await api.request(`/support/requests/${encodeURIComponent(ticket.id)}`, {
        method: "PATCH",
        body: { status: status.value, priority: priority.value },
      });
      setAlert("Request updated.");
      await loadRequests(false);
      await loadRequest(ticket.id);
    } catch (error) {
      handleApiError(error);
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

function createAssignmentForm(requestId) {
  const form = document.createElement("form");
  form.className = "oc-cluster";
  const input = document.createElement("input");
  input.className = "oc-input";
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "Authorized support staff user ID";
  input.pattern = "[0-9a-fA-F-]{36}";
  input.required = true;
  input.setAttribute("aria-label", "Support staff user ID");
  const button = element("button", "Assign", "oc-button oc-button--secondary");
  button.type = "submit";
  form.append(input, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await api.request(
        `/platform/support/requests/${encodeURIComponent(requestId)}/assignment`,
        { method: "POST", body: { supportUserId: input.value } },
      );
      setAlert("Request assigned.");
      await loadRequest(requestId);
      await loadRequests(false);
    } catch (error) {
      handleApiError(error);
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

document
  .querySelector("#request-create-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api.request("/support/requests", {
        method: "POST",
        body: {
          subject: form.elements.subject.value,
          body: form.elements.body.value,
        },
      });
      form.reset();
      setAlert("Support request submitted.");
      await loadRequests(false);
      if (result?.request?.id) await loadRequest(result.request.id);
    } catch (error) {
      handleApiError(error);
    } finally {
      button.disabled = false;
    }
  });

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = loginForm.elements.email.value;
  const password = loginForm.elements.password.value;
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  loginMessage.hidden = true;
  try {
    await api.request("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    loginForm.reset();
    await loadSession();
  } catch (error) {
    try {
      if (await mfaLogin.begin(error, email, password)) return;
    } catch (mfaError) {
      loginMessage.textContent =
        mfaError instanceof Error
          ? mfaError.message
          : "MFA verification failed.";
      loginMessage.hidden = false;
      return;
    }
    loginMessage.textContent =
      error instanceof Error ? error.message : "Sign in failed.";
    loginMessage.hidden = false;
  } finally {
    button.disabled = false;
  }
});

const mfaLogin = createMfaLoginFlow({
  api,
  loginForm,
  message: loginMessage,
  onAuthenticated: loadSession,
});

document.querySelector("#support-refresh").addEventListener("click", () => {
  void loadRequests(false);
});
document.querySelector("#support-retry").addEventListener("click", () => {
  void loadSession();
});
document
  .querySelector("#support-retry-unavailable")
  .addEventListener("click", () => {
    void loadSession();
  });
document.querySelector("#request-next-page").addEventListener("click", () => {
  currentPage += 1;
  void loadRequests(true);
});
document
  .querySelector("#organization-select")
  .addEventListener("change", async (event) => {
    const organizationId = event.currentTarget.value;
    try {
      await api.request("/auth/organization", {
        method: "POST",
        body: { organizationId },
      });
      activeSession.organization = activeSession.memberships.find(
        (membership) => membership.organizationId === organizationId,
      );
      await populateOrganizations();
      await loadRequests(false);
    } catch (error) {
      handleApiError(error);
    }
  });
document
  .querySelector("#support-logout")
  .addEventListener("click", async () => {
    try {
      await api.request("/auth/logout", { method: "POST", body: {} });
    } finally {
      activeSession = undefined;
      document.querySelector("#support-logout").hidden = true;
      showView(views.login);
      setStatus("Signed out", "warning");
    }
  });

const sidebar = document.querySelector("#support-sidebar");
const backdrop = document.querySelector("#support-sidebar-backdrop");
const toggle = document.querySelector("#support-menu-toggle");
function closeNavigation() {
  sidebar.removeAttribute("data-open");
  backdrop.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open navigation");
  toggle.focus();
}
toggle.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute(
    "aria-label",
    open ? "Close navigation" : "Open navigation",
  );
  sidebar.dataset.open = String(open);
  backdrop.hidden = !open;
});
backdrop.addEventListener("click", closeNavigation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !backdrop.hidden) closeNavigation();
});

void loadSession();
