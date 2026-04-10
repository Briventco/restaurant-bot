const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");
const {
  resolveWhatsappChannelStatus,
  normalizeProvisioningState,
  getWhatsappProvisioningTransitions,
} = require("../utils/whatsappChannelStatus");

function createRestaurantRoutes({
  requireApiKey,
  requireRestaurantAccess,
  restaurantRepo,
  providerSessionRepo,
  restaurantHealthService,
  env,
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
        if (restaurantHealthService) {
          await restaurantHealthService.evaluateAndPersistRestaurantHealth({
            restaurantId: req.params.restaurantId,
            source: "restaurant_updated",
          });
        }

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
        if (restaurantHealthService) {
          await restaurantHealthService.evaluateAndPersistRestaurantHealth({
            restaurantId: req.restaurantId,
            source: "bot_settings_updated",
          });
        }

        res.status(200).json({
          restaurant,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/restaurant/whatsapp-status",
    requireApiKey(["restaurants.read"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const session = await providerSessionRepo.getSession(
          req.restaurantId,
          "whatsapp-web"
        );

        const whatsapp = resolveWhatsappChannelStatus({
          restaurant: req.restaurant,
          restaurantId: req.restaurantId,
          session,
          env,
        });

        res.status(200).json({
          whatsapp,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.patch(
    "/restaurant/whatsapp-config",
    requireApiKey(["restaurants.write"]),
    requireRestaurantAccess,
    validateBody({
      provider: { type: "string", required: false },
      configured: { type: "boolean", required: false },
      provisioningState: { type: "string", required: false },
      phone: { type: "string", required: false },
      phoneNumberId: { type: "string", required: false },
      wabaId: { type: "string", required: false },
      notes: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const currentWhatsapp =
          req.restaurant && req.restaurant.whatsapp && typeof req.restaurant.whatsapp === "object"
            ? req.restaurant.whatsapp
            : {};

        const patch = {
          ...currentWhatsapp,
        };

        if (typeof req.body.provider === "string") {
          patch.provider = req.body.provider.trim().toLowerCase();
        }

        if (typeof req.body.configured === "boolean") {
          patch.configured = req.body.configured;
        }

        if (typeof req.body.provisioningState === "string") {
          patch.provisioningState = normalizeProvisioningState(req.body.provisioningState);
        }

        if (typeof req.body.phone === "string") {
          patch.phone = req.body.phone.trim();
        }

        if (typeof req.body.phoneNumberId === "string") {
          patch.phoneNumberId = req.body.phoneNumberId.trim();
        }

        if (typeof req.body.wabaId === "string") {
          patch.wabaId = req.body.wabaId.trim();
        }

        if (typeof req.body.notes === "string") {
          patch.notes = req.body.notes.trim();
        }

        if (patch.configured === false) {
          patch.provider = "";
          patch.provisioningState = "unassigned";
          patch.phone = "";
          patch.phoneNumberId = "";
          patch.wabaId = "";
          patch.notes = "";
        }

        const currentProvisioningState = normalizeProvisioningState(
          currentWhatsapp.provisioningState,
          currentWhatsapp.configured ? "reserved" : "unassigned"
        );
        const nextProvisioningState = normalizeProvisioningState(
          patch.provisioningState,
          patch.configured ? "reserved" : "unassigned"
        );
        const allowedProvisioningTargets = new Set(
          getWhatsappProvisioningTransitions(currentProvisioningState).map((item) => item.targetState)
        );

        if (
          patch.configured !== false &&
          nextProvisioningState !== currentProvisioningState &&
          !allowedProvisioningTargets.has(nextProvisioningState)
        ) {
          res.status(400).json({
            error: `Cannot move WhatsApp provisioning from ${currentProvisioningState} to ${nextProvisioningState}.`,
            code: "invalid_whatsapp_provisioning_transition",
            provisioningTransitions: getWhatsappProvisioningTransitions(currentProvisioningState),
          });
          return;
        }

        if (patch.configured !== false && ["verified", "active"].includes(nextProvisioningState)) {
          if (!String(patch.phone || "").trim()) {
            res.status(400).json({
              error: "Display phone is required before WhatsApp provisioning can be verified.",
              code: "whatsapp_phone_required",
            });
            return;
          }

          if (
            String(patch.provider || "").trim().toLowerCase() === "meta-whatsapp-cloud-api" &&
            (!String(patch.phoneNumberId || "").trim() || !String(patch.wabaId || "").trim())
          ) {
            res.status(400).json({
              error: "Meta phone number ID and WABA ID are required before WhatsApp provisioning can be verified.",
              code: "whatsapp_meta_identifiers_required",
            });
            return;
          }
        }

        patch.provisioningState = patch.configured === false ? "unassigned" : nextProvisioningState;

        const restaurant = await restaurantRepo.upsertRestaurant(req.restaurantId, {
          whatsapp: patch,
        });
        if (restaurantHealthService) {
          await restaurantHealthService.evaluateAndPersistRestaurantHealth({
            restaurantId: req.restaurantId,
            source: "whatsapp_config_updated",
          });
        }

        res.status(200).json({
          success: true,
          whatsapp: restaurant.whatsapp || patch,
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
