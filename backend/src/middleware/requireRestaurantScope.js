const { authError, sendAuthError } = require("../auth/authErrors");
const { ROLES } = require("../auth/permissions");

function resolveRouteRestaurantId(req) {
  return (
    (req.params && req.params.restaurantId) ||
    (req.context && req.context.restaurantId) ||
    ""
  );
}

function requireRestaurantScope(req, res, next) {
  if (!req.user) {
    sendAuthError(res, authError(401, "unauthorized", "Authentication required"));
    return;
  }

  const routeRestaurantId = resolveRouteRestaurantId(req);
  if (!routeRestaurantId) {
    sendAuthError(
      res,
      authError(400, "missing_restaurant_scope", "Missing restaurantId in route")
    );
    return;
  }

  if (req.user.role === ROLES.SUPER_ADMIN) {
    next();
    return;
  }

  if (req.user.restaurantId !== routeRestaurantId) {
    sendAuthError(
      res,
      authError(403, "forbidden_scope", "User cannot access this restaurant", {
        restaurantId: routeRestaurantId,
      })
    );
    return;
  }

  next();
}

module.exports = {
  requireRestaurantScope,
};
