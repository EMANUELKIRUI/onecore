import { ApiError, createApiClient } from "../packages/ui/src/api-client.js";

const apiBase =
  document
    .querySelector('meta[name="onecore-api-base"]')
    ?.getAttribute("content") ?? "";
const api = createApiClient(apiBase);
const form = document.querySelector("#setup-form");
const message = document.querySelector("#setup-message");
const submit = document.querySelector("#setup-submit");
const signIn = document.querySelector("#setup-signin");
let token = new URLSearchParams(location.hash.slice(1)).get("token");

window.history.replaceState(null, "", location.pathname);

function showMessage(text, isError = false) {
  message.className = isError ? "oc-alert oc-alert--error" : "oc-alert";
  message.textContent = text;
  message.hidden = !text;
}

if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
  form.hidden = false;
  document.querySelector("#setup-password").focus();
} else {
  showMessage(
    "This setup link is invalid, expired, or already used. Ask a platform administrator for a new invitation.",
    true,
  );
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity() || !token) return;
  const password = form.elements.password.value;
  if (password !== form.elements.passwordConfirm.value) {
    showMessage("The passwords do not match.", true);
    form.elements.passwordConfirm.focus();
    return;
  }

  submit.disabled = true;
  showMessage("Setting your password…");
  try {
    await api.request("/auth/owner-credential-setup", {
      method: "POST",
      body: { token, password },
    });
    token = undefined;
    form.reset();
    form.hidden = true;
    signIn.hidden = false;
    showMessage(
      "Password set. Sign in to complete mandatory authenticator setup before accessing your organization.",
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) {
      showMessage(
        "This setup link is invalid, expired, revoked, or already used. Ask a platform administrator for a new invitation.",
        true,
      );
    } else if (error instanceof ApiError && error.status === 429) {
      showMessage("Too many setup attempts. Wait before trying again.", true);
    } else {
      showMessage(
        "We could not confirm account setup. If you already submitted this form, try signing in; otherwise ask a platform administrator for a fresh invitation.",
        true,
      );
    }
  } finally {
    submit.disabled = false;
  }
});
