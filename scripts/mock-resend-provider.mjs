import { appendFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const capturePath = process.env.ONECORE_E2E_EMAIL_CAPTURE_PATH;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (
    capturePath &&
    url.origin === "https://api.resend.com" &&
    url.pathname === "/emails"
  ) {
    await appendFile(
      capturePath,
      `${JSON.stringify(JSON.parse(String(init?.body ?? "{}")))}\n`,
      { mode: 0o600 },
    );
    return new globalThis.Response(
      JSON.stringify({ id: "onecore-e2e-provider-accepted" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return originalFetch(input, init);
};
