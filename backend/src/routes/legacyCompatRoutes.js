const { Router } = require("express");

const DEPRECATION_SUNSET = "Wed, 30 Sep 2026 00:00:00 GMT";

function createLegacyCompatRoutes({
  env,
  logger,
  requireApiKey,
  requireRestaurantAccess,
  orderService,
}) {
  const router = Router();

  function setCompatContext(req, res, next) {
    if (!env.BACKEND_DEFAULT_RESTAURANT_ID) {
      res.status(500).json({
        error:
          "BACKEND_DEFAULT_RESTAURANT_ID is not set. Compatibility routes are disabled.",
      });
      return;
    }

    req.context = {
      ...(req.context || {}),
      restaurantId: env.BACKEND_DEFAULT_RESTAURANT_ID,
    };

    next();
  }

  function markDeprecated(req, res, replacementEndpoint) {
    logger.warn("Temporary compatibility endpoint used", {
      endpoint: req.originalUrl,
      replacementEndpoint,
      restaurantId: req.context && req.context.restaurantId,
    });

    res.setHeader("X-Deprecated", "true");
    res.setHeader("X-Replacement-Endpoint", replacementEndpoint);
    res.setHeader("Sunset", DEPRECATION_SUNSET);
  }

  router.get(
    "/getOrders",
    setCompatContext,
    requireApiKey(["orders.read"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        markDeprecated(
          req,
          res,
          "/api/v1/restaurants/:restaurantId/orders"
        );

        const orders = await orderService.listOrders({
          restaurantId: req.restaurantId,
          status: req.query.status || "",
          limit: req.query.limit || 50,
        });

        res.status(200).json({ orders });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/confirmOrder",
    setCompatContext,
    requireApiKey(["orders.write"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        markDeprecated(
          req,
          res,
          "/api/v1/restaurants/:restaurantId/orders/:orderId/confirm"
        );

        const orderId = req.query.orderId || (req.body && req.body.orderId);
        if (!orderId) {
          res.status(400).json({ error: "Missing orderId" });
          return;
        }

        const order = await orderService.confirmOrder({
          restaurantId: req.restaurantId,
          orderId,
          actor: {
            type: "staff",
            id: req.auth.keyId,
          },
        });

        res.status(200).json({
          success: true,
          message: "Order confirmed and customer notified",
          order,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/markItemsUnavailable",
    setCompatContext,
    requireApiKey(["orders.write"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        markDeprecated(
          req,
          res,
          "/api/v1/restaurants/:restaurantId/orders/:orderId/unavailable-items"
        );

        const orderId = req.body && req.body.orderId;
        let items = req.body && req.body.items;
        const note = req.body && typeof req.body.note === "string" ? req.body.note : "";

        if (!Array.isArray(items) || !items.length) {
          const singleItem = req.body && req.body.item;
          if (typeof singleItem === "string" && singleItem.trim()) {
            items = [singleItem.trim()];
          }
        }

        if (!orderId || !Array.isArray(items) || !items.length) {
          res.status(400).json({
            error: "Missing orderId or items",
          });
          return;
        }

        const order = await orderService.markItemsUnavailable({
          restaurantId: req.restaurantId,
          orderId,
          items,
          note,
          actor: {
            type: "staff",
            id: req.auth.keyId,
          },
        });

        res.status(200).json({
          success: true,
          message: "Customer notified successfully",
          order,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createLegacyCompatRoutes,
};
