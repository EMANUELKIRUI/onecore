import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function copyIfPresent(source, destination) {
  try {
    await cp(source, destination, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

describe("Marketing static image assets", () => {
  it("copies nested images into dist without touching the real app output", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "onecore-marketing-assets-"),
    );
    const appRoot = join(temporaryRoot, "apps", "marketing");
    const uiRoot = join(temporaryRoot, "packages", "ui");
    const scriptRoot = join(temporaryRoot, "scripts");
    const imagesRoot = join(appRoot, "assets", "images");
    const heroBytes = Buffer.from("temporary hero image fixture");
    const dashboardBytes = Buffer.from("temporary dashboard image fixture");

    try {
      await Promise.all([
        mkdir(appRoot, { recursive: true }),
        mkdir(join(uiRoot, "src"), { recursive: true }),
        mkdir(scriptRoot, { recursive: true }),
        mkdir(imagesRoot, { recursive: true }),
      ]);

      for (const filename of ["index.html", "homepage.js", "styles.css"]) {
        await cp(
          join(workspaceRoot, "apps", "marketing", filename),
          join(appRoot, filename),
        );
      }
      await copyIfPresent(
        join(workspaceRoot, "apps", "marketing", "register"),
        join(appRoot, "register"),
      );
      await cp(
        join(
          workspaceRoot,
          "apps",
          "marketing",
          "assets",
          "images",
          ".gitkeep",
        ),
        join(imagesRoot, ".gitkeep"),
      );
      await writeFile(join(imagesRoot, "hero-business-owner.webp"), heroBytes);
      await writeFile(
        join(imagesRoot, "business-dashboard.webp"),
        dashboardBytes,
      );
      await cp(
        join(workspaceRoot, "packages", "ui", "styles.css"),
        join(uiRoot, "styles.css"),
      );
      await cp(
        join(workspaceRoot, "packages", "ui", "src"),
        join(uiRoot, "src"),
        {
          recursive: true,
        },
      );
      await cp(
        join(workspaceRoot, "scripts", "build-static-app.mjs"),
        join(scriptRoot, "build-static-app.mjs"),
      );

      execFileSync(
        process.execPath,
        [join(scriptRoot, "build-static-app.mjs"), "marketing"],
        {
          cwd: temporaryRoot,
          env: {
            PATH: process.env.PATH ?? "",
            ONECORE_API_BASE_PATH: "/api",
          },
          stdio: "pipe",
        },
      );

      const distRoot = join(appRoot, "dist");
      expect(
        await readFile(join(distRoot, "assets", "images", ".gitkeep")),
      ).toEqual(Buffer.alloc(0));
      expect(
        await readFile(
          join(distRoot, "assets", "images", "hero-business-owner.webp"),
        ),
      ).toEqual(heroBytes);
      expect(
        await readFile(
          join(distRoot, "assets", "images", "business-dashboard.webp"),
        ),
      ).toEqual(dashboardBytes);
      expect(
        await readFile(join(distRoot, "register", "index.html"), "utf8"),
      ).toContain('<meta name="onecore-api-base" content="/api" />');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  describe("Support static build configuration", () => {
    it("injects the same-origin API path and preserves fail-closed application assets", async () => {
      const temporaryRoot = await mkdtemp(
        join(tmpdir(), "onecore-support-build-"),
      );
      const appRoot = join(temporaryRoot, "apps", "support");
      const uiRoot = join(temporaryRoot, "packages", "ui");
      const scriptRoot = join(temporaryRoot, "scripts");

      try {
        await Promise.all([
          mkdir(appRoot, { recursive: true }),
          mkdir(join(uiRoot, "src"), { recursive: true }),
          mkdir(scriptRoot, { recursive: true }),
        ]);
        await Promise.all([
          cp(
            join(workspaceRoot, "apps", "support", "index.html"),
            join(appRoot, "index.html"),
          ),
          cp(
            join(workspaceRoot, "apps", "support", "app.js"),
            join(appRoot, "app.js"),
          ),
          cp(
            join(workspaceRoot, "packages", "ui", "styles.css"),
            join(uiRoot, "styles.css"),
          ),
          cp(
            join(workspaceRoot, "packages", "ui", "src"),
            join(uiRoot, "src"),
            { recursive: true },
          ),
          cp(
            join(workspaceRoot, "scripts", "build-static-app.mjs"),
            join(scriptRoot, "build-static-app.mjs"),
          ),
        ]);

        execFileSync(
          process.execPath,
          [join(scriptRoot, "build-static-app.mjs"), "support"],
          {
            cwd: temporaryRoot,
            env: {
              PATH: process.env.PATH ?? "",
              ONECORE_API_BASE_PATH: "/api",
            },
            stdio: "pipe",
          },
        );

        const distRoot = join(appRoot, "dist");
        expect(await readFile(join(distRoot, "index.html"), "utf8")).toContain(
          '<meta name="onecore-api-base" content="/api" />',
        );
        expect(await readFile(join(distRoot, "app.js"), "utf8")).toContain(
          "The authorized Support API is not configured or could not be reached.",
        );
        const vercel = JSON.parse(
          await readFile(
            join(workspaceRoot, "apps", "support", "vercel.json"),
            "utf8",
          ),
        );
        expect(vercel.outputDirectory).toBe("dist");
        expect(vercel.rewrites).toEqual([
          {
            source: "/api/:path*",
            destination: "https://onecore-api.onrender.com/:path*",
          },
        ]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  });
});
