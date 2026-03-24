const { Router } = require("express");

function createOutboxRoutes({
  requireApiKey,
  requireRestaurantAccess,
  outboxService,
}) {
  const router = Router({ mergeParams: true });

  const requireOutboxRead = requireApiKey({
    anyOf: ["outbox.read", "orders.read"],
  });
  const requireOutboxManage = requireApiKey({
    anyOf: ["outbox.manage", "orders.write"],
  });

  router.get(
    "/outbox/messages",
    requireOutboxRead,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const messages = await outboxService.listOutboxMessages({
          restaurantId: req.restaurantId,
          status: req.query.status || "",
          limit: req.query.limit || 50,
        });

        res.status(200).json({ messages });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/outbox/messages/:messageId",
    requireOutboxRead,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const message = await outboxService.getOutboxMessageById(req.params.messageId);

        if (!message || message.restaurantId !== req.restaurantId) {
          res.status(404).json({ error: "Outbox message not found" });
          return;
        }

        res.status(200).json({ message });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/outbox/stats",
    requireOutboxRead,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const stats = await outboxService.getOutboxStats(req.restaurantId);
        res.status(200).json({ stats });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/outbox/messages/:messageId/retry",
    requireOutboxManage,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const message = await outboxService.retryOutboxMessage({
          restaurantId: req.restaurantId,
          messageId: req.params.messageId,
          requestedBy: req.auth && req.auth.keyId ? req.auth.keyId : "ops",
        });

        if (!message) {
          res.status(404).json({ error: "Outbox message not found" });
          return;
        }

        res.status(200).json({
          success: true,
          message,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createOutboxRoutes,
};
