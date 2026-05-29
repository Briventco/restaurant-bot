const { ROLES } = require("../auth/permissions");

function extractRestaurantId(req) {
  return (
    (req.params && req.params.restaurantId) ||
    (req.context && req.context.restaurantId) ||
    ""
  );
}

function isValidRestaurantId(value) {
  return /^[a-zA-Z0-9_-]{2,100}$/.test(value);
}

function createRequireRestaurantAccess({ restaurantRepo }) {
  return async function requireRestaurantAccess(req, res, next) {
    try {
      const restaurantId = extractRestaurantId(req);

      if (!restaurantId || !isValidRestaurantId(restaurantId)) {
        res.status(400).json({ error: "Invalid restaurantId" });
        return;
      }

      const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      // ── Verification gate ──────────────────────────────────────────────────
      // Super admins can always access all restaurants regardless of verification.
      // Existing restaurants without verificationStatus default to "approved" so
      // they are not disrupted. New self-serve signups start as "pending".
      const userRole = req.user && req.user.role;
      if (userRole && userRole !== ROLES.SUPER_ADMIN) {
        const status = String(restaurant.verificationStatus || "approved");
        if (status === "pending") {
          res.status(403).json({
            error:
              "Your account is pending verification. You will be notified once it has been reviewed.",
            code: "PENDING_VERIFICATION",
          });
          return;
        }
        if (status === "rejected") {
          res.status(403).json({
            error: "Your account verification was rejected.",
            code: "VERIFICATION_REJECTED",
            reason: String(restaurant.verificationRejectionReason || ""),
          });
          return;
        }
      }

      req.restaurantId = restaurantId;
      req.restaurant = restaurant;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  createRequireRestaurantAccess,
};
