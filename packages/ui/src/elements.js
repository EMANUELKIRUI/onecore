export function announce(message, type = "info") {
  const region = document.querySelector("[data-toast-region]");
  if (!region) return;
  const toast = document.createElement("div");
  toast.className = `oc-toast oc-toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.textContent = message;
  region.replaceChildren(toast);
  window.setTimeout(() => {
    if (toast.isConnected) toast.remove();
  }, 6_000);
}

export function setTheme(theme) {
  if (!["system", "light", "dark"].includes(theme)) {
    throw new TypeError("Unsupported theme");
  }
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
  return theme;
}

export function initializeDisclosure(button, target) {
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    target.hidden = expanded;
  });
}

export function setBusy(element, busy) {
  element.setAttribute("aria-busy", String(busy));
  if ("disabled" in element) {
    element.disabled = busy;
    return;
  }
  element
    .querySelectorAll("button, input, select, textarea")
    .forEach((field) => {
      field.disabled = busy;
    });
}

export function setFieldError(field, message) {
  const container = field.closest(".oc-field");
  if (!container || !field.id) {
    throw new TypeError("A labeled field inside .oc-field is required");
  }
  const errorId = `${field.id}-error`;
  let error = container.querySelector("[data-field-error]");
  if (message) {
    if (!error) {
      error = field.ownerDocument.createElement("span");
      error.id = errorId;
      error.dataset.fieldError = "true";
      error.className = "oc-field__error";
      container.append(error);
    }
    error.id = errorId;
    error.textContent = message;
    field.setAttribute("aria-invalid", "true");
    const describedBy = new Set(
      (field.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean),
    );
    describedBy.add(errorId);
    field.setAttribute("aria-describedby", [...describedBy].join(" "));
    return;
  }
  error?.remove();
  field.removeAttribute("aria-invalid");
  const describedBy = (field.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (describedBy.length) {
    field.setAttribute("aria-describedby", describedBy.join(" "));
  } else {
    field.removeAttribute("aria-describedby");
  }
}

export function createStatusBadge(label, status = "neutral") {
  const badge = document.createElement("span");
  const variant = ["success", "warning", "danger", "info"].includes(status)
    ? status
    : "neutral";
  badge.className = `oc-badge oc-badge--${variant}`;
  badge.textContent = label;
  return badge;
}

export function showDialog(dialog) {
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new TypeError("Expected a native dialog element");
  }
  dialog.showModal();
}
