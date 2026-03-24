const { Router } = require("express");

const ATTENTION_STATUSES = new Set(["paused", "disconnected", "error", "disabled"]);

function toSafeLimit(value, fallback, maxValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(maxValue, Math.max(1, Math.round(parsed)));
}

function createOpsRoutes({
  requireApiKey,
  requireRestaurantAccess,
  orderService,
  outboxService,
  channelSessionService,
  inboundEventRepo,
}) {
  const router = Router({ mergeParams: true });

  const requirePilotRead = requireApiKey({
    allOf: ["orders.read", "outbox.read", "channels.session.read"],
  });

  router.get(
    "/ops/pilot-snapshot",
    requirePilotRead,
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const restaurantId = req.restaurantId;
        const orderLimit = toSafeLimit(req.query.orderLimit, 5, 20);
        const inboundLimit = toSafeLimit(req.query.inboundLimit, 10, 50);

        const [session, outboxStats, recentOrders, recentInboundEvents] = await Promise.all([
          channelSessionService.getStatus({
            channel: "whatsapp-web",
            restaurantId,
          }),
          outboxService.getOutboxStats(restaurantId),
          orderService.listOrders({
            restaurantId,
            limit: orderLimit,
          }),
          inboundEventRepo.listRecentInboundEvents(restaurantId, {
            limit: inboundLimit,
          }),
        ]);

        const sessionStatus = String((session && session.status) || "unknown");
        const failedOutboxCount = Number(
          outboxStats && outboxStats.counts ? outboxStats.counts.failed || 0 : 0
        );
        const pendingOutboxCount = Number(
          outboxStats && Number.isFinite(outboxStats.pendingTotal)
            ? outboxStats.pendingTotal
            : 0
        );

        res.status(200).json({
          restaurantId,
          timestamp: new Date().toISOString(),
          bot: (req.restaurant && req.restaurant.bot) || {},
          whatsappSession: session,
          outbox: outboxStats,
          recentOrders,
          recentInboundEvents,
          attention: {
            needsAttention:
              ATTENTION_STATUSES.has(sessionStatus) ||
              failedOutboxCount > 0 ||
              pendingOutboxCount > 0,
            sessionNeedsAttention: ATTENTION_STATUSES.has(sessionStatus),
            outboxPending: pendingOutboxCount,
            outboxFailed: failedOutboxCount,
            sessionStatus,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createOpsRoutes,
};
