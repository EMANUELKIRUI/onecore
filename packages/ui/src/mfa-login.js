export function createMfaLoginFlow({
  api,
  loginForm,
  message,
  onAuthenticated,
}) {
  const stage = document.createElement("section");
  stage.className = "oc-stack";
  stage.hidden = true;
  stage.setAttribute("aria-labelledby", "mfa-login-title");
  loginForm.after(stage);

  let credentials;
  let flowStatus;

  function showMessage(text, isError = false) {
    message.hidden = !text;
    message.className = isError ? "oc-alert oc-alert--error" : "oc-alert";
    message.textContent = text;
  }

  function leaveFlow() {
    credentials = undefined;
    flowStatus = undefined;
    stage.replaceChildren();
    stage.hidden = true;
    loginForm.hidden = false;
    showMessage("");
    loginForm.querySelector('input[name="password"]').value = "";
    loginForm.querySelector('input[name="email"]').focus();
  }

  function buildStage(provisioningUri) {
    const title = document.createElement("h2");
    title.id = "mfa-login-title";
    title.className = "oc-title";
    title.textContent =
      flowStatus === "enrollment_required"
        ? "Set up an authenticator"
        : "Verify your authenticator";

    const instructions = document.createElement("p");
    instructions.className = "oc-muted";
    instructions.textContent =
      flowStatus === "enrollment_required"
        ? "Add OneCore to Google Authenticator or another TOTP app, then enter the six-digit code."
        : "Enter the current six-digit code from your authenticator app.";

    stage.replaceChildren(title, instructions);
    if (provisioningUri) {
      const setupLink = document.createElement("a");
      setupLink.className = "oc-auth-back";
      setupLink.href = provisioningUri;
      setupLink.textContent = "Open authenticator setup";
      setupLink.setAttribute(
        "aria-label",
        "Open the OneCore TOTP authenticator provisioning link",
      );
      stage.append(setupLink);
      const uri = document.createElement("p");
      uri.className = "oc-help";
      uri.textContent = provisioningUri;
      stage.append(uri);
    }

    const codeForm = document.createElement("form");
    codeForm.className = "oc-stack";
    const field = document.createElement("div");
    field.className = "oc-field";
    const label = document.createElement("label");
    label.htmlFor = "mfa-login-code";
    label.textContent = "Authenticator code";
    const input = document.createElement("input");
    input.id = "mfa-login-code";
    input.className = "oc-input";
    input.name = "code";
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "one-time-code";
    input.pattern = "[0-9]{6}";
    input.minLength = 6;
    input.maxLength = 6;
    input.required = true;
    field.append(label, input);

    const submit = document.createElement("button");
    submit.className = "oc-button oc-button--wide";
    submit.type = "submit";
    submit.textContent =
      flowStatus === "enrollment_required"
        ? "Verify and finish setup"
        : "Verify and sign in";
    const cancel = document.createElement("button");
    cancel.className = "oc-button oc-button--quiet";
    cancel.type = "button";
    cancel.textContent = "Use a different account";

    codeForm.append(field, submit, cancel);
    stage.append(codeForm);
    const status = document.createElement("p");
    status.className = "oc-muted";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    stage.append(status);
    stage.hidden = false;
    loginForm.hidden = true;
    input.focus();

    cancel.addEventListener("click", leaveFlow);
    codeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!codeForm.reportValidity() || !credentials) return;
      submit.disabled = true;
      cancel.disabled = true;
      status.textContent = "Verifying authenticator code…";
      showMessage("");
      try {
        const body = { ...credentials, code: input.value };
        await api.request(
          flowStatus === "enrollment_required"
            ? "/auth/mfa/enroll"
            : "/auth/mfa/challenge",
          { method: "POST", body },
        );
        credentials = undefined;
        loginForm.reset();
        loginForm.hidden = false;
        stage.hidden = true;
        stage.replaceChildren();
        await onAuthenticated();
      } catch (error) {
        input.value = "";
        input.focus();
        status.textContent = "";
        showMessage(
          error instanceof Error
            ? error.message
            : "Authenticator verification could not be completed.",
          true,
        );
      } finally {
        submit.disabled = false;
        cancel.disabled = false;
      }
    });
  }

  return {
    async begin(error, email, password) {
      const requirement = error?.mfa;
      if (
        error?.code !== "MFA_REQUIRED" ||
        requirement?.required !== true ||
        requirement.method !== "totp" ||
        !["enrollment_required", "challenge_required"].includes(
          requirement.status,
        )
      ) {
        return false;
      }

      credentials = { email, password };
      flowStatus = requirement.status;
      loginForm.querySelector('input[name="password"]').value = "";
      showMessage("");

      let provisioningUri;
      if (flowStatus === "enrollment_required") {
        showMessage("Preparing authenticator setup…");
        const enrollment = await api.request("/auth/mfa/enroll", {
          method: "POST",
          body: credentials,
        });
        provisioningUri = enrollment?.mfa?.provisioningUri;
        if (
          typeof provisioningUri !== "string" ||
          !provisioningUri.startsWith("otpauth://totp/")
        ) {
          credentials = undefined;
          throw new Error("The authenticator setup response was invalid.");
        }
      }

      showMessage("");
      buildStage(provisioningUri);
      return true;
    },
  };
}
