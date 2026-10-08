import { ApiError, createApiClient } from "../../../packages/ui/src/api-client.js";

const apiBase =
  document
    .querySelector('meta[name="onecore-api-base"]')
    ?.getAttribute("content") ?? "";
const api = createApiClient(apiBase);
const list = document.querySelector("#request-list");
const detail = document.querySelector("#request-detail");
const message = document.querySelector("#request-message");
const applications = new Map();
let selectedReference = null;
let requestSequence = 0;

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function showMessage(text, kind = "status") {
  message.className =
    kind === "error" ? "oc-alert oc-alert--error" : "oc-alert";
  message.textContent = text;
  message.hidden = !text;
}

function field(label, value) {
  const item = document.createElement("div");
  item.append(node("dt", label, "oc-label"), node("dd", value || "—"));
  return item;
}

function renderList() {
  list.replaceChildren();
  if (!applications.size) {
    list.append(
      node("p", "No organization applications are awaiting review.", "oc-state oc-state--empty"),
    );
    return;
  }
  const table = document.createElement("table");
  table.className = "oc-table";
  const head = document.createElement("thead");
  const headingRow = document.createElement("tr");
  for (const title of ["Organization", "Owner", "Industry", "Status", "Action"]) {
    headingRow.append(node("th", title));
  }
  head.append(headingRow);
  const body = document.createElement("tbody");
  for (const application of applications.values()) {
    const row = document.createElement("tr");
    row.append(
      node("td", application.organization.name),
      node("td", `${application.applicant.ownerName} (${application.applicant.ownerEmail})`),
      node("td", application.organization.industry),
      node("td", application.status),
    );
    const actionCell = document.createElement("td");
    const view = node("button", "View", "oc-button oc-button--secondary");
    view.type = "button";
    view.addEventListener("click", () => showDetail(application.reference));
    actionCell.append(view);
    row.append(actionCell);
    body.append(row);
  }
  table.append(head, body);
  list.append(table);
}

function showDetail(reference) {
  const application = applications.get(reference);
  if (!application) return;
  selectedReference = reference;
  detail.replaceChildren();
  const organization = application.organization;
  const applicant = application.applicant;
  const information = document.createElement("dl");
  information.className = "oc-stack";
  for (const [label, value] of [
    ["Organization", organization.name],
    ["Reference", organization.slug],
    ["Industry", organization.industry],
    ["Business type", organization.deploymentType],
    ["Business email", applicant.contactEmail],
    ["Business phone", applicant.contactPhone],
    ["Website", applicant.website],
    ["Country", applicant.countryCode],
    ["Region / county", applicant.region],
    ["City", applicant.city],
    ["Address", applicant.address],
    ["Owner", applicant.ownerName],
    ["Owner email", applicant.ownerEmail],
    ["Requested modules", applicant.requestedModules.join(", ") || "None"],
    ["Submitted", new Date(application.submittedAt).toLocaleString()],
    ["Status", application.status],
  ]) {
    information.append(field(label, value));
  }
  detail.append(information);

  const actions = node("div", undefined, "oc-cluster");
  if (application.status === "PENDING") {
    actions.append(
      actionButton("Begin review", "UNDER_REVIEW", reference),
    );
  } else if (application.status === "UNDER_REVIEW") {
    actions.append(
      actionButton("Approve", "APPROVED", reference),
      actionButton("Reject", "REJECTED", reference, "oc-button oc-button--secondary"),
    );
  }
  if (actions.childElementCount) detail.append(actions);
}

function actionButton(label, status, reference, className = "oc-button") {
  const button = node("button", label, className);
  button.type = "button";
  button.addEventListener("click", () => transition(reference, status, button));
  return button;
}

async function loadApplications() {
  const sequence = ++requestSequence;
  list.replaceChildren(node("p", "Loading organization requests…", "oc-state oc-state--loading"));
  showMessage("");
  try {
    const response = await api.request("/platform/organization-applications");
    if (sequence !== requestSequence) return;
    if (!Array.isArray(response.applications)) {
      throw new ApiError(200, "INVALID_RESPONSE", "Invalid application list.");
    }
    applications.clear();
    for (const application of response.applications) {
      if (
        typeof application.reference === "string" &&
        application.organization &&
        application.applicant
      ) {
        applications.set(application.reference, application);
      }
    }
    renderList();
    if (selectedReference && applications.has(selectedReference)) {
      showDetail(selectedReference);
    } else {
      selectedReference = null;
      detail.replaceChildren(node("p", "Choose an application to review.", "oc-muted"));
    }
  } catch (error) {
    if (sequence !== requestSequence) return;
    list.replaceChildren();
    detail.replaceChildren();
    if (error instanceof ApiError && error.status === 401) {
      showMessage("Sign in to OneCore to continue.", "error");
      const link = node("a", "Sign in");
      link.href = "../";
      link.className = "oc-button";
      detail.append(link);
    } else if (error instanceof ApiError && error.status === 403) {
      showMessage(
        "Forbidden: organization requests are restricted to platform Superadmins.",
        "error",
      );
    } else {
      showMessage(
        error instanceof ApiError
          ? error.message
          : "Organization requests could not be loaded. Try again.",
        "error",
      );
    }
  }
}

async function transition(reference, status, button) {
  button.disabled = true;
  showMessage("Updating application status…");
  try {
    await api.request(
      `/platform/organization-applications/${encodeURIComponent(reference)}/status`,
      { method: "POST", body: { status } },
    );
    showMessage(`Application moved to ${status}.`);
    await loadApplications();
    if (status === "REJECTED") {
      detail.replaceChildren(node("p", "Application rejected.", "oc-state"));
      selectedReference = null;
    }
  } catch (error) {
    button.disabled = false;
    showMessage(
      error instanceof ApiError && error.status === 403
        ? "Forbidden: only a platform Superadmin can review applications."
        : error instanceof ApiError && error.status === 409
          ? "The application status has changed. Refresh the list and review it again."
          : error instanceof ApiError
            ? error.message
            : "The status could not be updated. Please retry.",
      "error",
    );
  }
}

document
  .querySelector("#refresh-applications")
  .addEventListener("click", loadApplications);
void loadApplications();
