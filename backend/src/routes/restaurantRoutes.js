const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");

function createRestaurantRoutes({
  requireApiKey,
  requireRestaurantAccess,
  restaurantRepo,
}) {
  const router = Router({ mergeParams: true });

  router.get(
    "/restaurant",
    requireApiKey(["restaurants.read"]),
    requireRestaurantAccess,
    async (req, res) => {
      res.status(200).json({
        restaurant: req.restaurant,
      });
    }
  );

  router.put(
    "/restaurant",
    requireApiKey(["restaurants.write"]),
    validateBody({
      name: { type: "string", required: true, minLength: 2 },
      timezone: { type: "string", required: false },
      flow: { type: "object", required: false },
      bot: { type: "object", required: false },
    }),
    async (req, res, next) => {
      try {
        const existingRestaurant = await restaurantRepo.getRestaurantById(
          req.params.restaurantId
        );
        const existingBot = (existingRestaurant && existingRestaurant.bot) || {};
        const incomingBot = req.body.bot && typeof req.body.bot === "object" ? req.body.bot : {};
        const payload = {
          name: req.body.name.trim(),
          timezone:
            req.body.timezone ||
            (existingRestaurant && existingRestaurant.timezone) ||
            "Africa/Lagos",
          flow: req.body.flow || (existingRestaurant && existingRestaurant.flow) || {},
        };

        if (req.body.bot && typeof req.body.bot === "object") {
          payload.bot = {
            ...existingBot,
            ...incomingBot,
          };
        } else if (existingRestaurant && existingRestaurant.bot) {
          payload.bot = existingRestaurant.bot;
        }

        const restaurant = await restaurantRepo.upsertRestaurant(req.params.restaurantId, payload);

        res.status(200).json({ restaurant });
      } catch (error) {
        next(error);
      }
    }
  );

  router.patch(
    "/restaurant/bot",
    requireApiKey(["restaurants.write"]),
    requireRestaurantAccess,
    validateBody({
      enabled: { type: "boolean", required: false },
      ignoreGroupChats: { type: "boolean", required: false },
      allowedChatIds: { type: "array", required: false },
      allowedPhonePrefixes: { type: "array", required: false },
      allowedChannels: { type: "array", required: false },
    }),
    async (req, res, next) => {
      try {
        const currentBot = (req.restaurant && req.restaurant.bot) || {};
        const patch = {};

        if (typeof req.body.enabled === "boolean") {
          patch.enabled = req.body.enabled;
        }

        if (typeof req.body.ignoreGroupChats === "boolean") {
          patch.ignoreGroupChats = req.body.ignoreGroupChats;
        }

        if (Array.isArray(req.body.allowedChatIds)) {
          patch.allowedChatIds = req.body.allowedChatIds
            .map((value) => String(value || "").trim())
            .filter(Boolean);
        }

        if (Array.isArray(req.body.allowedPhonePrefixes)) {
          patch.allowedPhonePrefixes = req.body.allowedPhonePrefixes
            .map((value) => String(value || "").trim())
            .filter(Boolean);
        }

        if (Array.isArray(req.body.allowedChannels)) {
          patch.allowedChannels = req.body.allowedChannels
            .map((value) => String(value || "").trim())
            .filter(Boolean);
        }

        const restaurant = await restaurantRepo.upsertRestaurant(req.restaurantId, {
          bot: {
            ...currentBot,
            ...patch,
          },
        });

        res.status(200).json({
          restaurant,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createRestaurantRoutes,
};
