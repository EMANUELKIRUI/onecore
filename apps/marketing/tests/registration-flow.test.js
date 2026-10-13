import { afterEach, describe, expect, it, vi } from "vitest";
import { URL } from "node:url";

class TestElement {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.replacementCount = 0;
    this.text = "";
    this.hidden = false;
    this.value = "";
    this.name = "";
    this.type = "";
    this.required = false;
    this.checked = false;
    this.disabled = false;
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  get elements() {
    return {
      namedItem: (name) =>
        this.querySelectorAll("input").find((item) => item.name === name),
    };
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.text = "";
    this.children = [...children];
    this.replacementCount += 1;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ preventDefault() {} });
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  querySelectorAll(selector) {
    const descendants = [];
    const visit = (node) => {
      for (const child of node.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    return descendants.filter((node) => {
      if (node.tagName !== "input") return false;
      if (selector.includes("[required]") && !node.required) return false;
      if (
        selector.includes('name="requestedModules"') &&
        node.name !== "requestedModules"
      ) {
        return false;
      }
      if (selector.includes(":checked") && !node.checked) return false;
      return selector === "input" || selector.startsWith("input[");
    });
  }

  checkValidity() {
    if (this.required && !this.value.trim()) return false;
    if (
      this.type === "email" &&
      this.value &&
      !/^\S+@\S+\.\S+$/.test(this.value)
    ) {
      return false;
    }
    if (this.type === "url" && this.value) {
      try {
        new URL(this.value);
      } catch {
        return false;
      }
    }
    return true;
  }

  reportValidity() {
    return this.checkValidity();
  }

  setCustomValidity() {}
}

class TestFormData {
  constructor(form) {
    this.form = form;
  }

  *entries() {
    for (const input of this.form.querySelectorAll("input")) {
      if (
        !input.name ||
        input.disabled ||
        (input.type === "checkbox" && !input.checked)
      ) {
        continue;
      }
      yield [input.name, input.value];
    }
  }
}

function findButton(root, label) {
  for (const child of root.children) {
    if (child.tagName === "button" && child.textContent === label) return child;
    const nested = findButton(child, label);
    if (nested) return nested;
  }
  return undefined;
}

function fillFields(form, values) {
  for (const [name, value] of Object.entries(values)) {
    form.elements.namedItem(name).value = value;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const businessDetails = {
  name: "Example Organization",
  slug: "example-organization",
  industry: "Retail",
  contactEmail: "business@example.test",
  contactPhone: "+254700000000",
  countryCode: "KE",
  region: "Nairobi",
  city: "Nairobi",
  address: "Example Street",
};

async function loadRegistration(fetchImplementation) {
  const elements = new Map(
    ["registration-form", "registration-progress", "registration-message"].map(
      (id) => [
        id,
        new TestElement(id === "registration-form" ? "form" : "div"),
      ],
    ),
  );
  const document = {
    createElement: (tagName) => new TestElement(tagName),
    querySelector(selector) {
      if (selector === 'meta[name="onecore-api-base"]') {
        return { getAttribute: () => "/api" };
      }
      return elements.get(selector.slice(1));
    },
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("FormData", TestFormData);
  vi.stubGlobal("fetch", fetchImplementation);
  vi.resetModules();
  await import("../register/registration.js?registration-flow-test");
  return elements;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("registration wizard async catalogue behavior", () => {
  it("preserves current-step input when a delayed module response rerenders the form", async () => {
    let resolveCatalogue;
    const catalogue = new Promise((resolve) => {
      resolveCatalogue = resolve;
    });
    const fetchImplementation = vi.fn(() => catalogue);
    const elements = await loadRegistration(fetchImplementation);
    const form = elements.get("registration-form");

    fillFields(form, businessDetails);
    await form.dispatch("submit");
    form.elements.namedItem("ownerName").value = "Example Owner";
    form.elements.namedItem("ownerEmail").value = "owner@example.test";
    const replacementCount = form.replacementCount;

    resolveCatalogue(
      new Response(JSON.stringify({ modules: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await vi.waitFor(() => {
      expect(form.replacementCount).toBeGreaterThan(replacementCount);
      expect(form.elements.namedItem("ownerName").value).toBe("Example Owner");
    });
  });

  it("reviews and submits with an empty catalogue as a confirmed pending application", async () => {
    const requests = [];
    let resolveSubmission;
    const submission = new Promise((resolve) => {
      resolveSubmission = resolve;
    });
    const fetchImplementation = vi.fn((url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/public/organization-applications/modules") {
        return Promise.resolve(jsonResponse({ modules: [] }));
      }
      if (url === "/api/public/organization-applications") {
        return submission;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const elements = await loadRegistration(fetchImplementation);
    const form = elements.get("registration-form");

    fillFields(form, businessDetails);
    await form.dispatch("submit");
    fillFields(form, {
      ownerName: "Example Owner",
      ownerEmail: "owner@example.test",
    });
    await form.dispatch("submit");
    await vi.waitFor(() => {
      expect(form.textContent).toContain(
        "No modules are currently available to request.",
      );
    });
    expect(form.textContent).toContain("No modules are currently available");
    await form.dispatch("submit");
    expect(form.textContent).toContain("Review your application");
    expect(form.textContent).toContain("No additional modules selected");
    expect(requests).toHaveLength(1);

    const submit = form.dispatch("submit");
    await vi.waitFor(() => {
      expect(
        requests.filter(
          ({ url }) => url === "/api/public/organization-applications",
        ),
      ).toHaveLength(1);
    });
    await form.dispatch("submit");
    expect(
      requests.filter(
        ({ url }) => url === "/api/public/organization-applications",
      ),
    ).toHaveLength(1);
    const submissionRequest = requests.find(
      ({ url }) => url === "/api/public/organization-applications",
    );
    expect(submissionRequest.options.method).toBe("POST");
    expect(submissionRequest.options.credentials).toBe("same-origin");
    expect(JSON.parse(submissionRequest.options.body)).toMatchObject({
      ...businessDetails,
      ownerName: "Example Owner",
      ownerEmail: "owner@example.test",
      requestedModules: [],
      deploymentType: "SAAS",
    });
    expect(JSON.parse(submissionRequest.options.body)).not.toHaveProperty(
      "password",
    );

    resolveSubmission(
      jsonResponse(
        {
          application: {
            reference: "example-organization",
            organizationName: "Example Organization",
            status: "PENDING",
            submittedAt: "2026-10-13T00:00:00.000Z",
          },
        },
        201,
      ),
    );
    await submit;
    expect(form.textContent).toContain("pending");
    expect(form.textContent).toContain("Status: PENDING");
    expect(requests).toHaveLength(2);
  });

  it("preserves a selected available module in the review and submission payload", async () => {
    const requests = [];
    const fetchImplementation = vi.fn(async (url, options = {}) => {
      requests.push({ url, options });
      return url === "/api/public/organization-applications/modules"
        ? jsonResponse({
            modules: [
              {
                name: "core.business_manager",
                displayName: "Business Manager",
              },
            ],
          })
        : jsonResponse(
            {
              application: {
                reference: "example-organization",
                organizationName: "Example Organization",
                status: "PENDING",
                submittedAt: "2026-10-13T00:00:00.000Z",
              },
            },
            201,
          );
    });
    const elements = await loadRegistration(fetchImplementation);
    const form = elements.get("registration-form");

    fillFields(form, businessDetails);
    await form.dispatch("submit");
    fillFields(form, {
      ownerName: "Example Owner",
      ownerEmail: "owner@example.test",
    });
    await form.dispatch("submit");
    await vi.waitFor(() => {
      expect(form.textContent).toContain("Business Manager");
    });
    const moduleCheckbox = form
      .querySelectorAll('input[name="requestedModules"]')
      .find((input) => input.value === "core.business_manager");
    moduleCheckbox.checked = true;
    await form.dispatch("submit");

    expect(form.textContent).toContain("Business Manager");
    expect(requests).toHaveLength(1);
    await form.dispatch("submit");

    const submission = requests.find(
      ({ url }) => url === "/api/public/organization-applications",
    );
    expect(JSON.parse(submission.options.body).requestedModules).toEqual([
      "core.business_manager",
    ]);
    expect(form.textContent).toContain("Status: PENDING");
  });

  it("shows the submission service error only after submit and preserves Review data for retry", async () => {
    const requests = [];
    let submissionAttempts = 0;
    const fetchImplementation = vi.fn((url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/public/organization-applications/modules") {
        return Promise.resolve(jsonResponse({ modules: [] }));
      }
      if (url === "/api/public/organization-applications") {
        submissionAttempts += 1;
        return Promise.resolve(
          submissionAttempts === 1
            ? jsonResponse(
                {
                  error: {
                    code: "SERVICE_UNAVAILABLE",
                    message: "The service is temporarily unavailable.",
                  },
                },
                503,
              )
            : jsonResponse(
                {
                  application: {
                    reference: "example-organization",
                    organizationName: "Example Organization",
                    status: "PENDING",
                    submittedAt: "2026-10-13T00:00:00.000Z",
                  },
                },
                201,
              ),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const elements = await loadRegistration(fetchImplementation);
    const form = elements.get("registration-form");
    const message = elements.get("registration-message");

    fillFields(form, businessDetails);
    await form.dispatch("submit");
    fillFields(form, {
      ownerName: "Example Owner",
      ownerEmail: "owner@example.test",
    });
    await form.dispatch("submit");
    await vi.waitFor(() => {
      expect(form.textContent).toContain("No modules are currently available");
    });
    await form.dispatch("submit");
    expect(form.textContent).toContain("Review your application");
    expect(requests).toHaveLength(1);

    await form.dispatch("submit");
    expect(message.textContent).toBe("The service is temporarily unavailable.");
    expect(form.textContent).toContain("Example Organization");
    expect(form.textContent).toContain("Example Owner");
    expect(submissionAttempts).toBe(1);

    await form.dispatch("submit");
    expect(submissionAttempts).toBe(2);
    expect(form.textContent).toContain("Status: PENDING");
  });

  it("does not label a failed catalogue request as an available empty result", async () => {
    let catalogueRequests = 0;
    const fetchImplementation = vi.fn((url) => {
      if (url !== "/api/public/organization-applications/modules") {
        throw new Error(`Unexpected request: ${url}`);
      }
      catalogueRequests += 1;
      return Promise.resolve(
        catalogueRequests === 1
          ? jsonResponse(
              {
                error: {
                  code: "SERVICE_UNAVAILABLE",
                  message: "The service is temporarily unavailable.",
                },
              },
              503,
            )
          : jsonResponse({ modules: [] }),
      );
    });
    const elements = await loadRegistration(fetchImplementation);
    const form = elements.get("registration-form");
    const message = elements.get("registration-message");

    await vi.waitFor(() => {
      expect(message.textContent).toContain("catalogue could not be loaded");
    });
    fillFields(form, businessDetails);
    await form.dispatch("submit");
    fillFields(form, {
      ownerName: "Example Owner",
      ownerEmail: "owner@example.test",
    });
    await form.dispatch("submit");
    expect(form.textContent).toContain("catalogue could not be loaded");
    expect(form.textContent).not.toContain(
      "No modules are currently available to request.",
    );
    expect(findButton(form, "Retry module catalogue")).toBeDefined();

    await findButton(form, "Retry module catalogue").dispatch("click");
    await vi.waitFor(() => {
      expect(form.textContent).toContain(
        "No modules are currently available to request.",
      );
    });
    expect(catalogueRequests).toBe(2);
    await findButton(form, "Back").dispatch("click");
    expect(form.elements.namedItem("ownerName").value).toBe("Example Owner");
  });
});
