const menuToggle = document.querySelector("#marketing-menu-toggle");
const navigation = document.querySelector("#marketing-nav");

function closeNavigation() {
  const wasOpen = menuToggle.getAttribute("aria-expanded") === "true";
  navigation.dataset.open = "false";
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation");
  if (wasOpen) menuToggle.focus();
}

menuToggle.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") !== "true";
  navigation.dataset.open = String(isOpen);
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  menuToggle.setAttribute(
    "aria-label",
    isOpen ? "Close navigation" : "Open navigation",
  );
  if (isOpen) navigation.querySelector("a")?.focus();
});

navigation.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", closeNavigation);
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    menuToggle.getAttribute("aria-expanded") === "true"
  ) {
    closeNavigation();
  }
});

document.querySelectorAll("[data-image-slot]").forEach((slot) => {
  const image = slot.querySelector("img[data-src]");
  const placeholder = slot.querySelector("[data-image-placeholder]");
  if (!image || !placeholder) return;

  image.addEventListener("load", () => {
    if (image.naturalWidth < 1) return;
    slot.classList.add("has-image");
    slot.dataset.imageState = "loaded";
    image.hidden = false;
    placeholder.hidden = true;
  });
  image.addEventListener("error", () => {
    slot.classList.remove("has-image");
    slot.dataset.imageState = "missing";
    image.hidden = true;
    placeholder.hidden = false;
    image.removeAttribute("src");
  });
  image.src = image.dataset.src;
});
