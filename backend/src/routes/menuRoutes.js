const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");

function createMenuRoutes({
  requireApiKey,
  requireRestaurantAccess,
  menuRepo,
  restaurantOnboardingService,
  restaurantHealthService,
}) {
  const router = Router({ mergeParams: true });

  router.get(
    "/menu-items",
    requireApiKey(["menu.read"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const items = await menuRepo.listMenuItems(req.restaurantId);
        res.status(200).json({ items });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/menu-items",
    requireApiKey(["menu.write"]),
    requireRestaurantAccess,
    validateBody({
      name: { type: "string", required: true, minLength: 1 },
      category: { type: "string", required: false },
      price: {
        required: true,
        custom: (value) =>
          typeof value !== "number" || value < 0 ? "price must be a positive number" : null,
      },
      available: { type: "boolean", required: false },
    }),
    async (req, res, next) => {
      try {
        const item = await menuRepo.createMenuItem(req.restaurantId, {
          name: req.body.name.trim(),
          category:
            typeof req.body.category === "string" ? req.body.category.trim() : "",
          price: req.body.price,
          available: req.body.available !== false,
        });
        if (restaurantHealthService) {
          await restaurantHealthService.evaluateAndPersistRestaurantHealth({
            restaurantId: req.restaurantId,
            source: "menu_created",
          });
        }
        if (restaurantOnboardingService) {
          await restaurantOnboardingService.syncRestaurantOnboardingProgress({
            restaurantId: req.restaurantId,
            actorId: req.user && req.user.uid ? req.user.uid : "menu",
          });
        }

        res.status(201).json({ item });
      } catch (error) {
        next(error);
      }
    }
  );

  router.patch(
    "/menu-items/:itemId",
    requireApiKey(["menu.write"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const patch = {};
        if (typeof req.body.name === "string") {
          patch.name = req.body.name.trim();
        }
        if (typeof req.body.category === "string") {
          patch.category = req.body.category.trim();
        }
        if (typeof req.body.price === "number") {
          patch.price = req.body.price;
        }
        if (typeof req.body.available === "boolean") {
          patch.available = req.body.available;
        }

        const updated = await menuRepo.updateMenuItem(
          req.restaurantId,
          req.params.itemId,
          patch
        );

        if (!updated) {
          res.status(404).json({ error: "Menu item not found" });
          return;
        }
        if (restaurantHealthService) {
          await restaurantHealthService.evaluateAndPersistRestaurantHealth({
            restaurantId: req.restaurantId,
            source: "menu_updated",
          });
        }
        if (restaurantOnboardingService) {
          await restaurantOnboardingService.syncRestaurantOnboardingProgress({
            restaurantId: req.restaurantId,
            actorId: req.user && req.user.uid ? req.user.uid : "menu",
          });
        }

        res.status(200).json({ item: updated });
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/menu-items/:itemId",
    requireApiKey(["menu.write"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        await menuRepo.deleteMenuItem(req.restaurantId, req.params.itemId);
        if (restaurantHealthService) {
          await restaurantHealthService.evaluateAndPersistRestaurantHealth({
            restaurantId: req.restaurantId,
            source: "menu_deleted",
          });
        }
        if (restaurantOnboardingService) {
          await restaurantOnboardingService.syncRestaurantOnboardingProgress({
            restaurantId: req.restaurantId,
            actorId: req.user && req.user.uid ? req.user.uid : "menu",
          });
        }
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createMenuRoutes,
};
