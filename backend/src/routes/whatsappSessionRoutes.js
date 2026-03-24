const { Router } = require("express");

function createWhatsappSessionRoutes({
  requireApiKey,
  requireRestaurantAccess,
  channelSessionService,
}) {
  const router = Router({ mergeParams: true });
  const channel = "whatsapp-web";
  const requireSessionRead = requireApiKey({
    anyOf: ["channels.session.read", "whatsapp.session.read"],
  });
  const requireSessionManage = requireApiKey({
    anyOf: ["channels.session.manage", "whatsapp.session.manage"],
  });

  router.post(
    "/whatsapp/session/start",
    requireSessionManage,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const session = await channelSessionService.start({
          channel,
          restaurantId: req.restaurantId,
        });
        res.status(200).json({ session });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/whatsapp/session/status",
    requireSessionRead,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const session = await channelSessionService.getStatus({
          channel,
          restaurantId: req.restaurantId,
        });
        res.status(200).json({ session });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/whatsapp/session/disconnect",
    requireSessionManage,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const session = await channelSessionService.disconnect({
          channel,
          restaurantId: req.restaurantId,
          reason: String((req.body && req.body.reason) || "").trim(),
        });
        res.status(200).json({ session });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/whatsapp/session/restart",
    requireSessionManage,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const session = await channelSessionService.restart({
          channel,
          restaurantId: req.restaurantId,
          reason: String((req.body && req.body.reason) || "").trim(),
          requestTimeoutMs:
            req.body && req.body.requestTimeoutMs !== undefined
              ? Number(req.body.requestTimeoutMs)
              : undefined,
        });
        res.status(200).json({ session });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/whatsapp/session/qr",
    requireSessionRead,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const qr = await channelSessionService.getQr({
          channel,
          restaurantId: req.restaurantId,
        });

        if (!qr) {
          res.status(404).json({ error: "No active QR is available" });
          return;
        }

        res.status(200).json({
          qr,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createWhatsappSessionRoutes,
};
