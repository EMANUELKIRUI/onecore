import { describe, expect, it, vi } from "vitest";
import { createStatusBadge, setBusy, setFieldError } from "../src/elements.js";

describe("shared UI components", () => {
  it("sets and clears a field error without replacing existing descriptions", () => {
    const attributes = new Map([["aria-describedby", "email-help"]]);
    const error = {
      dataset: {},
      remove: vi.fn(),
      set textContent(value) {
        this.text = value;
      },
    };
    const container = {
      querySelector: vi.fn(() => error),
      append: vi.fn(),
    };
    const field = {
      id: "email",
      ownerDocument: { createElement: vi.fn(() => error) },
      closest: vi.fn(() => container),
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
    };

    setFieldError(field, "Enter a valid email.");
    expect(attributes.get("aria-invalid")).toBe("true");
    expect(attributes.get("aria-describedby")).toBe("email-help email-error");
    expect(error.text).toBe("Enter a valid email.");

    setFieldError(field, "");
    expect(attributes.has("aria-invalid")).toBe(false);
    expect(attributes.get("aria-describedby")).toBe("email-help");
    expect(error.remove).toHaveBeenCalledOnce();
  });

  it("marks busy controls and restores their enabled state", () => {
    const button = {
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      disabled: false,
    };

    setBusy(button, true);
    expect(button.disabled).toBe(true);
    expect(button.attributes.get("aria-busy")).toBe("true");
    setBusy(button, false);
    expect(button.disabled).toBe(false);
  });

  it("creates status badges with constrained variants and text-only content", () => {
    const previousDocument = globalThis.document;
    const badge = {
      className: "",
      textContent: "",
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => badge) });
    try {
      expect(createStatusBadge("<script>", "danger")).toBe(badge);
      expect(badge.className).toBe("oc-badge oc-badge--danger");
      expect(badge.textContent).toBe("<script>");
      createStatusBadge("Unknown", "url");
      expect(badge.className).toBe("oc-badge oc-badge--neutral");
    } finally {
      vi.stubGlobal("document", previousDocument);
    }
  });
});
