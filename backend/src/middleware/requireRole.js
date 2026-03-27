const { authError, sendAuthError } = require("../auth/authErrors");

function normalizeRoles(input) {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input.filter((value) => typeof value === "string" && value.trim());
  }

  if (typeof input === "string" && input.trim()) {
    return [input.trim()];
  }

  return [];
}

function requireRole(...rolesInput) {
  const allowedRoles = normalizeRoles(
    rolesInput.length === 1 ? rolesInput[0] : rolesInput
  );

  return function roleMiddleware(req, res, next) {
    if (!req.user) {
      sendAuthError(res, authError(401, "unauthorized", "Authentication required"));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      sendAuthError(
        res,
        authError(403, "forbidden", "You do not have access to this resource", {
          allowedRoles,
          role: req.user.role,
        })
      );
      return;
    }

    next();
  };
}

module.exports = {
  requireRole,
};
