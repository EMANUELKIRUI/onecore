import { afterEach, describe, expect, it, vi } from "vitest";

class TestElement {
  constructor({ dataset = {}, links = [] } = {}) {
    this.dataset = { ...dataset };
    this.links = links;
    this.listeners = new Map();
    this.attributes = new Map();
    this.focused = false;
    this.classNames = new Set();
    this.classList = {
      add: (name) => this.classNames.add(name),
      remove: (name) => this.classNames.delete(name),
      contains: (name) => this.classNames.has(name),
    };
    this.hidden = false;
    this.naturalWidth = 0;
    this.source = "";
    this.placeholder = undefined;
    this.image = undefined;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.source = "";
  }

  querySelectorAll(selector) {
    return selector === "a" ? this.links : [];
  }

  querySelector(selector) {
    if (selector === "a") return this.links[0] ?? null;
    if (selector === "img[data-src]") return this.image;
    if (selector === "[data-image-placeholder]") return this.placeholder;
    return null;
  }

  focus() {
    this.focused = true;
  }

  set src(value) {
    this.source = value;
  }

  get src() {
    return this.source;
  }
}

function makeImageSlot(path) {
  const image = new TestElement({ dataset: { src: path } });
  image.hidden = true;
  const placeholder = new TestElement();
  const slot = new TestElement();
  slot.image = image;
  slot.placeholder = placeholder;
  return { slot, image, placeholder };
}

async function loadHomepageScript() {
  const firstLink = new TestElement();
  const secondLink = new TestElement();
  const navigation = new TestElement({ links: [firstLink, secondLink] });
  const menuToggle = new TestElement();
  menuToggle.setAttribute("aria-expanded", "false");
  const hero = makeImageSlot("./assets/images/hero-business-owner.webp.png");
  const dashboard = makeImageSlot("./assets/images/business-dashboard.png");
  const documentListeners = new Map();
  const document = {
    querySelector(selector) {
      if (selector === "#marketing-menu-toggle") return menuToggle;
      if (selector === "#marketing-nav") return navigation;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-image-slot]"
        ? [hero.slot, dashboard.slot]
        : [];
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };
  vi.stubGlobal("document", document);
  vi.resetModules();
  await import("../homepage.js?homepage-interaction-test");
  return {
    navigation,
    menuToggle,
    firstLink,
    documentListeners,
    hero,
    dashboard,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("marketing homepage interactions", () => {
  it("opens the compact navigation and closes it on Escape or link activation", async () => {
    const { navigation, menuToggle, firstLink, documentListeners } =
      await loadHomepageScript();

    menuToggle.dispatch("click");
    expect(navigation.dataset.open).toBe("true");
    expect(menuToggle.getAttribute("aria-expanded")).toBe("true");
    expect(menuToggle.getAttribute("aria-label")).toBe("Close navigation");
    expect(firstLink.focused).toBe(true);

    documentListeners.get("keydown")({ key: "Escape" });
    expect(navigation.dataset.open).toBe("false");
    expect(menuToggle.getAttribute("aria-expanded")).toBe("false");
    expect(menuToggle.focused).toBe(true);

    menuToggle.dispatch("click");
    firstLink.dispatch("click");
    expect(navigation.dataset.open).toBe("false");
  });

  it("shows local uploaded images only after load and keeps placeholders on missing files", async () => {
    const { hero, dashboard } = await loadHomepageScript();

    expect(hero.image.src).toBe("./assets/images/hero-business-owner.webp.png");
    expect(dashboard.image.src).toBe("./assets/images/business-dashboard.png");
    expect(hero.image.hidden).toBe(true);
    expect(hero.placeholder.hidden).toBe(false);

    hero.image.naturalWidth = 537;
    hero.image.dispatch("load");
    expect(hero.slot.classList.contains("has-image")).toBe(true);
    expect(hero.slot.dataset.imageState).toBe("loaded");
    expect(hero.image.hidden).toBe(false);
    expect(hero.placeholder.hidden).toBe(true);

    dashboard.image.dispatch("error");
    expect(dashboard.slot.classList.contains("has-image")).toBe(false);
    expect(dashboard.slot.dataset.imageState).toBe("missing");
    expect(dashboard.image.hidden).toBe(true);
    expect(dashboard.placeholder.hidden).toBe(false);
    expect(dashboard.image.src).toBe("");
  });
});
