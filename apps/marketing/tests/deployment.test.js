import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

async function readVercelConfig(app) {
  const contents = await readFile(
    new URL(`../../${app}/vercel.json`, import.meta.url),
    "utf8",
  );
  return JSON.parse(contents);
}

describe("frontend API proxy deployment", () => {
  it.each(["marketing", "business", "superadmin"])(
    "configures the %s build and same-origin API rewrite",
    async (app) => {
      const config = await readVercelConfig(app);

      expect(config.buildCommand).toBe(
        `ONECORE_API_BASE_PATH=/api node ../../scripts/build-static-app.mjs ${app}`,
      );
      expect(config.outputDirectory).toBe("dist");
      expect(config.rewrites).toEqual([
        {
          source: "/api/:path*",
          destination: "https://onecore-api.onrender.com/:path*",
        },
      ]);
    },
  );

  it("leaves Support disconnected from the API", async () => {
    const config = await readVercelConfig("support");

    expect(config.buildCommand).toBe(
      "node ../../scripts/build-static-app.mjs support",
    );
    expect(config.outputDirectory).toBe("dist");
    expect(config.rewrites).toBeUndefined();
  });
});
