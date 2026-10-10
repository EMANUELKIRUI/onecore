import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api-client.js";
import { applyBranding, filterNavigation } from "../src/capabilities.js";

describe("shared UI foundations", () => {
  it("uses same-origin credentials and parses API error contracts", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication is required.",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const api = createApiClient("/api", fetchImplementation);

    await expect(api.request("/auth/session")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication is required.",
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("sends JSON mutations and rejects cross-origin base paths", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const api = createApiClient("", fetchImplementation);

    await expect(
      api.request("/auth/logout", { method: "POST", body: {} }),
    ).resolves.toBeNull();
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(() => createApiClient("https://api.example.test")).toThrow(
      TypeError,
    );
    expect(() => createApiClient("/\\attacker.example")).toThrow(TypeError);
    await expect(api.request("/\\attacker.example")).rejects.toThrow(TypeError);
  });

  it("sends idempotency headers and accepts only the expected success status", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sale: { status: "OPEN" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = createApiClient("", fetchImplementation);

    await expect(
      api.request("/organizations/org-1/sales", {
        method: "POST",
        body: { lines: [] },
        headers: { "Idempotency-Key": "checkout-key" },
        expectedStatus: 201,
      }),
    ).resolves.toEqual({ sale: { status: "OPEN" } });
    expect(fetchImplementation.mock.calls[0]?.[1].headers).toMatchObject({
      "Idempotency-Key": "checkout-key",
    });

    const unexpected = createApiClient(
      "",
      async () =>
        new Response(JSON.stringify({ sale: { status: "OPEN" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      unexpected.request("/organizations/org-1/sales", {
        expectedStatus: 201,
      }),
    ).rejects.toMatchObject({ status: 200, code: "UNEXPECTED_STATUS" });
  });

  it("normalizes network failures without exposing the underlying exception", async () => {
    const api = createApiClient("", async () => {
      throw new Error("private connection detail");
    });

    await expect(api.request("/auth/session")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      code: "NETWORK_ERROR",
      message:
        "The service could not be reached. Check your connection and try again.",
    });
  });

  it("preserves request cancellation instead of reporting a network failure", async () => {
    const abortError = new globalThis.DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    const fetchImplementation = vi.fn().mockRejectedValue(abortError);
    const api = createApiClient("", fetchImplementation);
    const controller = new globalThis.AbortController();
    controller.abort();

    await expect(
      api.request("/auth/session", { signal: controller.signal }),
    ).rejects.toBe(abortError);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/auth/session",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("filters capability-dependent navigation fail-closed", () => {
    const items = [
      { label: "Home", href: "/" },
      { label: "Users", href: "/users", permission: "users.read" },
      { label: "Inventory", href: "/inventory", module: "inventory" },
      {
        label: "Inventory Admin",
        href: "/inventory/admin",
        permission: "inventory.manage",
        module: "inventory",
      },
    ];

    expect(
      filterNavigation(items, ["users.read"], ["inventory"]).map(
        (item) => item.label,
      ),
    ).toEqual(["Home", "Users", "Inventory"]);
    expect(filterNavigation(items).map((item) => item.label)).toEqual(["Home"]);
  });

  it("accepts only safe hexadecimal organization brand colors", () => {
    const style = { setProperty: vi.fn() };
    const element = { style };

    applyBranding(element, { primaryColor: "#168" });
    expect(style.setProperty).toHaveBeenCalledWith(
      "--oc-color-primary",
      "#168",
    );
    style.setProperty.mockClear();
    applyBranding(element, {
      primaryColor: "url(javascript:alert(1))",
    });
    expect(style.setProperty).not.toHaveBeenCalled();
  });
});
