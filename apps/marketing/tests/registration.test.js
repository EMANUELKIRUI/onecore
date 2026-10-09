import { describe, expect, it } from "vitest";
import { parseApplicationResponse } from "../register/application-response.js";

describe("organization application response", () => {
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
