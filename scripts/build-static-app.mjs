import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { log } from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const appName = process.argv[2];
const appNames = ["business", "marketing", "superadmin", "support"];
if (!appNames.includes(appName)) {
  throw new Error(`Choose a supported static app: ${appNames.join(", ")}`);
}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(workspaceRoot, "apps", appName);
const outputRoot = join(appRoot, "dist");

function publicUrl(value, variableName) {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      `${variableName} must be an HTTP(S) URL without credentials`,
    );
  }
  return value.replace(/\/+$/, "") + "/";
}

function apiBasePath(value) {
  if (!value) return "";
  if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(value) || value.startsWith("//")) {
    throw new Error("ONECORE_API_BASE_PATH must be a same-origin URL path");
  }
  return value.replace(/\/+$/, "");
}

function htmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const entry of await readdir(appRoot, { withFileTypes: true })) {
  if (["tests", "dist", "README.md", "vercel.json"].includes(entry.name))
    continue;
  if (appName === "business" && entry.name === "organization-requests")
    continue;
  await cp(join(appRoot, entry.name), join(outputRoot, entry.name), {
    recursive: true,
  });
}

const uiRoot = join(workspaceRoot, "packages", "ui");
const deployedUiRoot = join(outputRoot, "packages", "ui");
await mkdir(deployedUiRoot, { recursive: true });
await cp(join(uiRoot, "styles.css"), join(deployedUiRoot, "styles.css"));
await cp(join(uiRoot, "src"), join(deployedUiRoot, "src"), {
  recursive: true,
});

const urls = {
  business: publicUrl(process.env.ONECORE_BUSINESS_URL, "ONECORE_BUSINESS_URL"),
  marketing: publicUrl(
    process.env.ONECORE_MARKETING_URL,
    "ONECORE_MARKETING_URL",
  ),
};
const configuredApiBase = apiBasePath(process.env.ONECORE_API_BASE_PATH);
const requiredAppUrl =
  appName === "marketing" ? "ONECORE_BUSINESS_URL" : "ONECORE_MARKETING_URL";
if (process.env.VERCEL === "1" && !process.env[requiredAppUrl]) {
  throw new Error(`${requiredAppUrl} is required for this Vercel app root`);
}

async function configureHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await configureHtml(entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;

    let html = await readFile(entryPath, "utf8");
    if (urls.business) {
      const businessUrl = htmlAttribute(urls.business);
      html = html.replaceAll('href="../business/"', `href="${businessUrl}"`);
      html = html.replaceAll('href="../../business/"', `href="${businessUrl}"`);
    }
    if (urls.marketing) {
      html = html.replaceAll(
        /href="(?:\.\.\/){1,2}marketing\/"/g,
        `href="${htmlAttribute(urls.marketing)}"`,
      );
    }
    html = html.replace(
      /(<meta\s+name="onecore-api-base"\s+content=")[^"]*(")/g,
      `$1${configuredApiBase}$2`,
    );
    await writeFile(entryPath, html);
  }
}

await configureHtml(outputRoot);
log(`Built ${appName} static app at ${relative(workspaceRoot, outputRoot)}`);
