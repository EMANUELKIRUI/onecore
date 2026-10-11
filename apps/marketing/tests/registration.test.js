import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { parseApplicationResponse } from "../register/application-response.js";

const registration = await readFile(
  new URL("../register/registration.js", import.meta.url),
  "utf8",
);

describe("organization application response", () => {
  it("omits a blank optional website from the strict API request", () => {
    expect(registration).toContain(
      "if (!applicationInput.website) delete applicationInput.website;",
    );
  });

  it("accepts and returns the actual application status and reference", () => {
    const application = {
      reference: "organization-reference",
      organizationName: "Example Organization",
      status: "PENDING",
      submittedAt: "2026-10-09T20:00:00.000Z",
    };

    expect(parseApplicationResponse({ application })).toBe(application);
  });

  it.each([
    undefined,
    {},
    { reference: "reference" },
    {
      reference: "reference",
      organizationName: "Example Organization",
      status: "UNKNOWN",
      submittedAt: "2026-10-09T20:00:00.000Z",
    },
    {
      reference: "reference",
      organizationName: "Example Organization",
      status: "PENDING",
      submittedAt: "not-a-date",
    },
  ])("rejects malformed application response %#", (application) => {
    expect(() => parseApplicationResponse({ application })).toThrow(
      expect.objectContaining({
        name: "ApiError",
        status: 201,
        code: "INVALID_RESPONSE",
      }),
    );
  });
});
