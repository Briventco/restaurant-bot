function hasAuthorizationHeader(req) {
  const header = req.header("authorization");
  return typeof header === "string" && header.trim().length > 0;
}

function createRequirePortalOrApiKey({
  requireApiKey,
  requireAuth,
  requirePermission,
  requireRestaurantScope,
}) {
  return function requirePortalOrApiKey(requiredPermissions = []) {
    const requireLegacyApiKey = requireApiKey(requiredPermissions);
    const requirePortalPermission = requirePermission(requiredPermissions);

    return function portalOrApiKeyMiddleware(req, res, next) {
      if (!hasAuthorizationHeader(req)) {
        requireLegacyApiKey(req, res, next);
        return;
      }

      requireAuth(req, res, (authError) => {
        if (authError) {
          next(authError);
          return;
        }

        requireRestaurantScope(req, res, (scopeError) => {
          if (scopeError) {
            next(scopeError);
            return;
          }

          requirePortalPermission(req, res, next);
        });
      });
    };
  };
}

module.exports = {
  createRequirePortalOrApiKey,
};
