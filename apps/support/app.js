const sidebar = document.querySelector("#support-sidebar");
const backdrop = document.querySelector("#support-sidebar-backdrop");
const toggle = document.querySelector("#support-menu-toggle");

function closeNavigation() {
  sidebar.removeAttribute("data-open");
  backdrop.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open navigation");
  toggle.focus();
}

toggle.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute(
    "aria-label",
    open ? "Close navigation" : "Open navigation",
  );
  sidebar.dataset.open = String(open);
  backdrop.hidden = !open;
  if (open) sidebar.querySelector("a")?.focus();
});

backdrop.addEventListener("click", closeNavigation);
sidebar.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", closeNavigation);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeNavigation();
});
