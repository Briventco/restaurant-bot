const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");

function createPaymentRoutes({ requireApiKey, requireRestaurantAccess, paymentService }) {
  const router = Router({ mergeParams: true });

  router.post(
    "/orders/:orderId/payment-receipts",
    requireApiKey(["payments.write"]),
    requireRestaurantAccess,
    validateBody({
      receiptUrl: { type: "string", required: true, minLength: 5 },
      amount: {
        required: true,
        custom: (value) =>
          typeof value !== "number" || value <= 0 ? "amount must be a positive number" : null,
      },
      reference: { type: "string", required: false },
      note: { type: "string", required: false },
      submittedBy: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const result = await paymentService.submitPaymentReceipt({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          receiptUrl: req.body.receiptUrl,
          amount: req.body.amount,
          reference: req.body.reference || "",
          note: req.body.note || "",
          submittedBy: req.body.submittedBy || req.auth.keyId,
        });

        res.status(201).json({
          success: true,
          receipt: result.receipt,
          order: result.order,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/orders/:orderId/payment-receipts",
    requireApiKey(["payments.read"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        const receipts = await paymentService.listPaymentReceipts({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
        });

        res.status(200).json({ receipts });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/orders/:orderId/payment-review/confirm",
    requireApiKey(["payments.write"]),
    requireRestaurantAccess,
    validateBody({
      receiptId: { type: "string", required: false },
      note: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const result = await paymentService.confirmPaymentReview({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          receiptId: req.body.receiptId || "",
          actorId: req.auth && req.auth.keyId ? req.auth.keyId : "staff",
          note: req.body.note || "",
        });

        res.status(200).json({
          success: true,
          order: result.order,
          receipt: result.receipt,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/orders/:orderId/payment-review/reject",
    requireApiKey(["payments.write"]),
    requireRestaurantAccess,
    validateBody({
      receiptId: { type: "string", required: false },
      reason: { type: "string", required: false },
      note: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const result = await paymentService.rejectPaymentReview({
          restaurantId: req.restaurantId,
          orderId: req.params.orderId,
          receiptId: req.body.receiptId || "",
          actorId: req.auth && req.auth.keyId ? req.auth.keyId : "staff",
          reason: req.body.reason || "",
          note: req.body.note || "",
        });

        res.status(200).json({
          success: true,
          order: result.order,
          receipt: result.receipt,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createPaymentRoutes,
};
