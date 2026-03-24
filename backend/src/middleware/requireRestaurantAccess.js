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
