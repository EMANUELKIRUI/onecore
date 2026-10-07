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

export function showDialog(dialog) {
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new TypeError("Expected a native dialog element");
  }
  dialog.showModal();
}
