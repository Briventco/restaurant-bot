const { authError, sendAuthError } = require("../auth/authErrors");

function normalizePermissionRule(requiredPermissions) {
  if (!requiredPermissions) {
    return { allOf: [] };
  }

  if (Array.isArray(requiredPermissions)) {
    return { allOf: requiredPermissions };
  }

  if (typeof requiredPermissions === "string") {
    return { allOf: [requiredPermissions] };
  }

  if (typeof requiredPermissions === "object") {
    const allOf = Array.isArray(requiredPermissions.allOf)
      ? requiredPermissions.allOf
      : [];
    const anyOf = Array.isArray(requiredPermissions.anyOf)
      ? requiredPermissions.anyOf
      : [];

    if (!allOf.length && !anyOf.length) {
      return { allOf: [] };
    }

    return { allOf, anyOf };
  }

  return { allOf: [] };
}

function hasPermissionList(userPermissions, requiredPermissions) {
  const permissions = Array.isArray(userPermissions) ? userPermissions : [];

  if (permissions.includes("*")) {
    return true;
  }

  return requiredPermissions.every((permission) => permissions.includes(permission));
}

function hasPermissionRule(userPermissions, permissionRule) {
  const allOf =
    permissionRule && Array.isArray(permissionRule.allOf) ? permissionRule.allOf : [];
  const anyOf =
    permissionRule && Array.isArray(permissionRule.anyOf) ? permissionRule.anyOf : [];

  if (!hasPermissionList(userPermissions, allOf)) {
    return false;
  }

  if (!anyOf.length) {
    return true;
  }

  return anyOf.some((permission) => hasPermissionList(userPermissions, [permission]));
}

function requirePermission(requiredPermissions = []) {
  const rule = normalizePermissionRule(requiredPermissions);

  return function permissionMiddleware(req, res, next) {
    if (!req.user) {
      sendAuthError(res, authError(401, "unauthorized", "Authentication required"));
      return;
    }

    if (!hasPermissionRule(req.user.permissions, rule)) {
      sendAuthError(
        res,
        authError(403, "forbidden", "Missing required permissions", {
          requiredPermissions: rule,
        })
      );
      return;
    }

    next();
  };
}

module.exports = {
  requirePermission,
};
