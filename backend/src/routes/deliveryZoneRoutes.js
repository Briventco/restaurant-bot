const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");

function createDeliveryZoneRoutes({
  requireApiKey,
  requireRestaurantAccess,
  deliveryZoneRepo,
  restaurantOnboardingService,
}) {
  const router = Router({ mergeParams: true });

  const requireZonesRead = requireApiKey({
    anyOf: ["deliveryZones.read", "restaurants.read"],
  });
  const requireZonesWrite = requireApiKey({
    anyOf: ["deliveryZones.write", "restaurants.write"],
  });

  router.get(
    "/delivery-zones",
    requireZonesRead,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const zones = await deliveryZoneRepo.listDeliveryZones(req.restaurantId);
        res.status(200).json({ zones });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/delivery-zones",
    requireZonesWrite,
    requireRestaurantAccess,
    validateBody({
      name: { type: "string", required: true, minLength: 1 },
      fee: {
        required: true,
        custom: (value) =>
          typeof value !== "number" || value < 0 ? "fee must be a positive number" : null,
      },
      etaMinutes: {
        required: false,
        custom: (value) =>
          value !== undefined && (typeof value !== "number" || value < 0)
            ? "etaMinutes must be a positive number"
            : null,
      },
      enabled: { type: "boolean", required: false },
      notes: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const zone = await deliveryZoneRepo.createDeliveryZone(req.restaurantId, {
          name: req.body.name.trim(),
          fee: req.body.fee,
          etaMinutes: Number.isFinite(Number(req.body.etaMinutes))
            ? Number(req.body.etaMinutes)
            : 0,
          enabled: req.body.enabled !== false,
          notes: String(req.body.notes || "").trim(),
        });
        if (restaurantOnboardingService) {
          await restaurantOnboardingService.syncRestaurantOnboardingProgress({
            restaurantId: req.restaurantId,
            actorId: req.user && req.user.uid ? req.user.uid : "delivery",
          });
        }

        res.status(201).json({
          success: true,
          zone,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.patch(
    "/delivery-zones/:zoneId",
    requireZonesWrite,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const patch = {};

        if (typeof req.body.name === "string") {
          patch.name = req.body.name.trim();
        }
        if (typeof req.body.fee === "number") {
          if (req.body.fee < 0) {
            res.status(400).json({ error: "fee must be a positive number" });
            return;
          }
          patch.fee = req.body.fee;
        }
        if (typeof req.body.etaMinutes === "number") {
          if (req.body.etaMinutes < 0) {
            res.status(400).json({ error: "etaMinutes must be a positive number" });
            return;
          }
          patch.etaMinutes = req.body.etaMinutes;
        }
        if (typeof req.body.enabled === "boolean") {
          patch.enabled = req.body.enabled;
        }
        if (typeof req.body.notes === "string") {
          patch.notes = req.body.notes.trim();
        }

        const zone = await deliveryZoneRepo.updateDeliveryZone(
          req.restaurantId,
          req.params.zoneId,
          patch
        );

        if (!zone) {
          res.status(404).json({ error: "Delivery zone not found" });
          return;
        }
        if (restaurantOnboardingService) {
          await restaurantOnboardingService.syncRestaurantOnboardingProgress({
            restaurantId: req.restaurantId,
            actorId: req.user && req.user.uid ? req.user.uid : "delivery",
          });
        }

        res.status(200).json({
          success: true,
          zone,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/delivery-zones/:zoneId",
    requireZonesWrite,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const existing = await deliveryZoneRepo.getDeliveryZoneById(
          req.restaurantId,
          req.params.zoneId
        );
        if (!existing) {
          res.status(404).json({ error: "Delivery zone not found" });
          return;
        }

        await deliveryZoneRepo.deleteDeliveryZone(req.restaurantId, req.params.zoneId);
        if (restaurantOnboardingService) {
          await restaurantOnboardingService.syncRestaurantOnboardingProgress({
            restaurantId: req.restaurantId,
            actorId: req.user && req.user.uid ? req.user.uid : "delivery",
          });
        }
        res.status(200).json({ success: true });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createDeliveryZoneRoutes,
};
