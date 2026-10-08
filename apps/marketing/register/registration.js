import { ApiError, createApiClient } from "../../../packages/ui/src/api-client.js";

const apiBase =
  document
    .querySelector('meta[name="onecore-api-base"]')
    ?.getAttribute("content") ?? "";
const api = createApiClient(apiBase);
const form = document.querySelector("#registration-form");
const progress = document.querySelector("#registration-progress");
const message = document.querySelector("#registration-message");
const steps = ["Business", "Owner", "Modules", "Review"];
const state = {
  step: 0,
  modules: [],
  values: {
    name: "",
    slug: "",
    industry: "",
    contactEmail: "",
    contactPhone: "",
    website: "",
    ownerName: "",
    ownerEmail: "",
    countryCode: "KE",
    region: "",
    city: "",
    address: "",
    requestedModules: [],
  },
  submitting: false,
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function field(name, label, type = "text", required = true, maxLength) {
  const wrapper = element("div", undefined, "oc-field");
  const id = `application-${name}`;
  const labelNode = element("label", label);
  labelNode.htmlFor = id;
  const input = document.createElement("input");
  input.id = id;
  input.name = name;
  input.type = type;
  input.required = required;
  input.autocomplete =
    name === "ownerEmail" || name === "contactEmail"
      ? "email"
      : name === "contactPhone"
        ? "tel"
        : "off";
  if (maxLength) input.maxLength = maxLength;
  input.value = state.values[name] ?? "";
  wrapper.append(labelNode, input);
  return wrapper;
}

function captureForm() {
  for (const [name, value] of new FormData(form).entries()) {
    if (name === "requestedModules") continue;
    if (name in state.values) state.values[name] = String(value).trim();
  }
  state.values.requestedModules = [
    ...form.querySelectorAll('input[name="requestedModules"]:checked'),
  ].map((input) => input.value);
}

function showMessage(text, kind = "error") {
  message.className =
    kind === "error" ? "oc-alert oc-alert--error" : "oc-alert";
  message.textContent = text;
  message.hidden = !text;
}

function updateProgress() {
  progress.replaceChildren();
  steps.forEach((label, index) => {
    const item = element("li", `${index + 1}. ${label}`, "oc-status");
    if (index === state.step) item.setAttribute("aria-current", "step");
    progress.append(item);
  });
}

function addSectionTitle(title, description) {
  form.append(element("h2", title, "oc-section-title"));
  if (description) form.append(element("p", description, "oc-muted"));
}

function renderReview() {
  const values = state.values;
  const details = [
    ["Organization", values.name],
    ["Industry", values.industry],
    ["Business email", values.contactEmail],
    ["Business phone", values.contactPhone],
    ["Website", values.website || "Not provided"],
    ["Owner", values.ownerName],
    ["Owner email", values.ownerEmail],
    ["Country", values.countryCode],
    ["Region / county", values.region],
    ["City", values.city],
    ["Address", values.address],
    [
      "Requested modules",
      state.modules
        .filter((module) => values.requestedModules.includes(module.name))
        .map((module) => module.displayName)
        .join(", ") || "No additional modules selected",
    ],
  ];
  const list = element("dl", undefined, "oc-stack");
  for (const [label, value] of details) {
    list.append(element("dt", label, "oc-label"));
    list.append(element("dd", value || "—"));
  }
  form.append(list);
  form.append(
    element(
      "p",
      "Plans and payment are not part of the currently supported application API.",
      "oc-help",
    ),
  );
}

function render() {
  updateProgress();
  form.replaceChildren();
  form.noValidate = state.step < 3;
  if (state.step === 0) {
    addSectionTitle("Business information", "Tell us about your organization.");
    form.append(field("name", "Organization name", "text", true, 200));
    form.append(field("slug", "Organization reference", "text", true, 100));
    form.append(field("industry", "Industry", "text", true, 100));
    form.append(field("contactEmail", "Business email", "email", true, 320));
    form.append(field("contactPhone", "Business phone", "tel", true, 50));
    form.append(field("website", "Website (optional)", "url", false, 2048));
    form.append(field("countryCode", "Country code (e.g. KE)", "text", true, 2));
    form.append(field("region", "County / region", "text", true, 100));
    form.append(field("city", "Town / city", "text", true, 100));
    form.append(field("address", "Business address", "text", true, 300));
  } else if (state.step === 1) {
    addSectionTitle(
      "Owner contact",
      "We will use these details to contact you about the application. No login is created at this stage.",
    );
    form.append(field("ownerName", "Owner / administrator name", "text", true, 200));
    form.append(field("ownerEmail", "Owner email", "email", true, 320));
  } else if (state.step === 2) {
    addSectionTitle(
      "Requested modules",
      "Choose from modules currently available in OneCore. Requests are subject to review and do not grant access.",
    );
    if (!state.modules.length) {
      form.append(
        element(
          "p",
          "No modules are currently available to request. You may continue with your application.",
          "oc-state oc-state--empty",
        ),
      );
    }
    for (const module of state.modules) {
      const label = element("label", undefined, "oc-checkbox");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "requestedModules";
      checkbox.value = module.name;
      checkbox.checked = state.values.requestedModules.includes(module.name);
      const text = element("span", module.displayName);
      if (module.description) text.append(element("small", module.description));
      label.append(checkbox, text);
      form.append(label);
    }
  } else {
    addSectionTitle("Review your application", "Check these details before submitting.");
    renderReview();
  }

  const actions = element("div", undefined, "oc-cluster");
  if (state.step > 0) {
    const back = element("button", "Back", "oc-button oc-button--secondary");
    back.type = "button";
    back.addEventListener("click", () => {
      captureForm();
      state.step -= 1;
      showMessage("");
      render();
    });
    actions.append(back);
  }
  const next = element(
    "button",
    state.step === 3 ? "Submit Application" : "Continue",
    "oc-button",
  );
  next.type = "submit";
  next.disabled = state.submitting;
  actions.append(next);
  form.append(actions);
}

function validationMessage() {
  for (const control of form.querySelectorAll("input[required]")) {
    control.setCustomValidity("");
    if (!control.checkValidity()) {
      control.reportValidity();
      return control.validationMessage || "Complete the required fields.";
    }
  }
  if (state.step === 0) {
    const code = state.values.countryCode;
    if (!/^[A-Z]{2}$/.test(code)) {
      return "Enter the two-letter country code in uppercase (for example, KE).";
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.values.slug)) {
      return "Use a lowercase organization reference with letters, numbers, and hyphens.";
    }
  }
  return "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.submitting) return;
  captureForm();
  const invalid = validationMessage();
  if (invalid) {
    showMessage(invalid);
    return;
  }
  showMessage("");
  if (state.step < 3) {
    state.step += 1;
    render();
    return;
  }

  state.submitting = true;
  render();
  try {
    const response = await api.request("/public/organization-applications", {
      method: "POST",
      body: { ...state.values, deploymentType: "SAAS" },
    });
    const application = response.application;
    form.replaceChildren();
    form.append(element("span", "Application received", "oc-status"));
    form.append(element("h2", "Your request is pending review", "oc-section-title"));
    form.append(
      element(
        "p",
        "Your OneCore Business Account request has been submitted successfully. A platform administrator must review it before an owner account can be set up.",
      ),
    );
    form.append(element("p", `Organization: ${application.organizationName}`));
    form.append(element("p", `Status: ${application.status}`));
    form.append(element("p", `Reference: ${application.reference}`));
    const signIn = element("a", "Sign in");
    signIn.href = "../../business/";
    signIn.className = "oc-button oc-button--secondary";
    form.append(signIn);
    state.step = 4;
    updateProgress();
  } catch (error) {
    const text =
      error instanceof ApiError && error.status === 409
        ? "An organization request already exists for these details. Contact OneCore support if you need help."
        : error instanceof ApiError && error.status === 400
          ? error.message
          : error instanceof ApiError
            ? error.message
            : "The application could not be submitted. Please try again.";
    showMessage(text);
    state.submitting = false;
    render();
  }
});

form.addEventListener("input", (event) => {
  if (event.target.name === "name" && !state.values.slug) {
    const slug = event.target.value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);
    const slugInput = form.elements.namedItem("slug");
    if (slugInput) slugInput.value = slug;
  }
});

async function loadModules() {
  try {
    const response = await api.request(
      "/public/organization-applications/modules",
    );
    if (!Array.isArray(response.modules)) {
      throw new ApiError(200, "INVALID_RESPONSE", "Invalid module catalog.");
    }
    state.modules = response.modules.filter(
      (module) =>
        typeof module.name === "string" &&
        typeof module.displayName === "string",
    );
    render();
  } catch {
    state.modules = [];
    showMessage(
      "The module catalog could not be loaded. Retry by refreshing this page.",
    );
    render();
  }
}

render();
void loadModules();
