const ROLES = Object.freeze({
  SUPER_ADMIN: "super_admin",
  RESTAURANT_ADMIN: "restaurant_admin",
  RESTAURANT_STAFF: "restaurant_staff",
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: Object.freeze(["*"]),
  [ROLES.RESTAURANT_ADMIN]: Object.freeze([
    "orders.read",
    "orders.write",
    "orders.update",
    "orders.transition",
    "menu.read",
    "menu.write",
    "payments.read",
    "payments.write",
    "payments.review",
    "deliveryZones.read",
    "deliveryZones.write",
    "delivery.read",
    "delivery.write",
    "whatsapp.session.read",
    "whatsapp.session.manage",
    "whatsapp.read",
    "channels.session.read",
    "channels.session.manage",
    "settings.read",
    "settings.write",
    "restaurants.read",
    "restaurants.write",
    "outbox.read",
    "outbox.manage",
    "messages.inbound",
  ]),
  [ROLES.RESTAURANT_STAFF]: Object.freeze([
    "orders.read",
    "orders.write",
    "orders.update",
    "menu.read",
    "payments.read",
    "deliveryZones.read",
    "delivery.read",
    "whatsapp.session.read",
    "whatsapp.read",
    "channels.session.read",
    "restaurants.read",
    "outbox.read",
  ]),
});

function isValidRole(role) {
  return Object.values(ROLES).includes(role);
}

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) {
    return [];
  }

  const deduped = new Set();
  for (const permission of permissions) {
    if (typeof permission === "string" && permission.trim()) {
      deduped.add(permission.trim());
    }
  }

  return Array.from(deduped);
}

function getDefaultPermissionsForRole(role) {
  if (!isValidRole(role)) {
    return [];
  }

  return Array.from(ROLE_PERMISSIONS[role] || []);
}

function resolvePermissionsForUser({ role, permissions }) {
  const explicit = normalizePermissions(permissions);
  if (explicit.length > 0) {
    if (role === ROLES.SUPER_ADMIN && !explicit.includes("*")) {
      return ["*", ...explicit];
    }
    return explicit;
  }

  return getDefaultPermissionsForRole(role);
}

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  isValidRole,
  getDefaultPermissionsForRole,
  resolvePermissionsForUser,
};
