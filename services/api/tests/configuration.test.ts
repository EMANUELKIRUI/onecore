import { loadConfig } from "@onecore/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryIdentityRepository } from "./identity-fixture.js";

describe("organization regional settings API validation", () => {
  it("rejects unsupported locales, unknown currencies, and invalid timezones", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      new MemoryIdentityRepository(),
    );
    const organizationId = crypto.randomUUID();

    for (const payload of [
      { locale: "fr-FR" },
      { currencyCode: "ZZZ" },
      { timezone: "Not/A-Timezone" },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/organizations/${organizationId}/configuration`,
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "BAD_REQUEST",
          message: "Invalid organization settings.",
        },
      });
    }

    await app.close();
  });
});
