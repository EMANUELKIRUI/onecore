export function filterNavigation(items, permissions = [], modules = []) {
  const grantedPermissions = new Set(permissions);
  const enabledModules = new Set(modules);
  return items.filter(
    (item) =>
      (!item.permission || grantedPermissions.has(item.permission)) &&
      (!item.module || enabledModules.has(item.module)),
  );
}

export function applyBranding(element, branding = {}) {
  if (typeof branding.primaryColor === "string") {
    const color = branding.primaryColor;
    if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color)) {
      element.style.setProperty("--oc-color-primary", color);
    }
  }
}
