const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");
const {
  ALL_ORDER_STATUSES,
  ORDER_STATUSES,
} = require("../domain/constants/orderStatuses");

function createOrderRoutes({ requireApiKey, requireRestaurantAccess, orderService }) {
  const router = Router({ mergeParams: true });

  router.get(
    "/orders",
    requireApiKey(["orders.read"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
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

  router.get(
    "/orders/:orderId",
    requireApiKey(["orders.read"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const order = await orderService.getOrder({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
        });

        res.status(200).json({ order });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/orders/:orderId/confirm",
    requireApiKey(["orders.write"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const order = await orderService.confirmOrder({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
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
    "/orders/:orderId/approve",
    requireApiKey(["orders.write"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const order = await orderService.confirmOrder({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          actor: {
            type: "staff",
            id: req.auth.keyId,
          },
        });

        res.status(200).json({
          success: true,
          message: "Order approved and customer notified",
          order,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/orders/:orderId/messages",
    requireApiKey(["orders.read"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const result = await orderService.listOrderMessages({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          limit: req.query.limit || 50,
        });

        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/orders/:orderId/unavailable-items",
    requireApiKey(["orders.write"]),
    requireRestaurantAccess,
    validateBody({
      items: {
        required: true,
        type: "array",
        minItems: 1,
      },
      note: {
        required: false,
        type: "string",
      },
    }),
    async (req, res, next) => {
      try {
        const order = await orderService.markItemsUnavailable({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          items: req.body.items,
          note: req.body.note || "",
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

  router.post(
    "/orders/:orderId/transition",
    requireApiKey(["orders.transition"]),
    requireRestaurantAccess,
    validateBody({
      toStatus: {
        required: true,
        type: "string",
        custom: (value) =>
          ALL_ORDER_STATUSES.includes(value) ? null : "Invalid toStatus",
      },
      reason: {
        required: false,
        type: "string",
      },
      metadata: {
        required: false,
        type: "object",
      },
    }),
    async (req, res, next) => {
      try {
        const order = await orderService.transitionOrderStatus({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          toStatus: req.body.toStatus,
          actor: {
            type: "staff",
            id: req.auth.keyId,
          },
          reason: req.body.reason || "manual_transition",
          metadata: req.body.metadata || {},
        });

        res.status(200).json({
          success: true,
          order,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/orders/:orderId/cancel",
    requireApiKey(["orders.write"]),
    requireRestaurantAccess,
    validateBody({
      reason: { required: false, type: "string" },
      metadata: { required: false, type: "object" },
    }),
    async (req, res, next) => {
      try {
        const order = await orderService.transitionOrderStatus({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          toStatus: ORDER_STATUSES.CANCELLED,
          actor: {
            type: "staff",
            id: req.auth.keyId,
          },
          reason: req.body.reason || "staff_cancelled_order",
          metadata: req.body.metadata || {},
        });

        res.status(200).json({
          success: true,
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
  createOrderRoutes,
};
