const { Router } = require("express");

function createFlutterwaveWebhookRoutes({
  env,
  logger,
  flutterwaveService,
  restaurantBillingService,
  orderService,
  orderRepo,
  billingTransactionRepo,
}) {
  const router = Router();
  const webhookPath = "/webhooks/flutterwave";

  async function handleSubscriptionPayment({ restaurantId, transactionId, verified }) {
    const expectedAmount = Number(env.SERVRA_BILLING_AMOUNT) || 0;
    const expectedCurrency = String(env.SERVRA_BILLING_CURRENCY || "NGN").trim().toUpperCase();
    const paidAmount = Number(verified.amount) || 0;
    const paidCurrency = String(verified.currency || "").trim().toUpperCase();

    if (paidCurrency !== expectedCurrency || paidAmount < expectedAmount) {
      logger.warn("Flutterwave subscription payment amount/currency mismatch", {
        transactionId,
        restaurantId,
        paidAmount,
        paidCurrency,
        expectedAmount,
        expectedCurrency,
      });
      return false;
    }

    await restaurantBillingService.confirmAutomaticPayment({
      restaurantId,
      provider: "flutterwave",
      transactionId,
      amount: paidAmount,
      currency: paidCurrency,
      txRef: verified.tx_ref || "",
    });

    logger.info("Flutterwave subscription payment confirmed", { restaurantId, transactionId });
    return true;
  }

  async function handleOrderPayment({ restaurantId, orderId, transactionId, verified }) {
    if (!orderId || !orderService || !orderRepo) {
      logger.warn("Flutterwave order payment webhook missing orderId or order dependencies", {
        transactionId,
        restaurantId,
        orderId,
      });
      return false;
    }

    const order = await orderRepo.getOrderById(restaurantId, orderId);
    if (!order) {
      logger.warn("Flutterwave order payment webhook referenced unknown order", {
        transactionId,
        restaurantId,
        orderId,
      });
      return false;
    }

    const paidAmount = Number(verified.amount) || 0;
    const paidCurrency = String(verified.currency || "").trim().toUpperCase();
    const expectedAmount = Number(order.total) || 0;

    if (paidCurrency !== "NGN" || paidAmount < expectedAmount) {
      logger.warn("Flutterwave order payment amount/currency mismatch", {
        transactionId,
        restaurantId,
        orderId,
        paidAmount,
        paidCurrency,
        expectedAmount,
      });
      return false;
    }

    await orderService.confirmAutomaticOrderPayment({
      restaurantId,
      orderId,
      provider: "flutterwave",
      transactionId,
      amount: paidAmount,
      currency: paidCurrency,
      txRef: verified.tx_ref || "",
    });

    logger.info("Flutterwave order payment confirmed", { restaurantId, orderId, transactionId });
    return true;
  }

  router.post(webhookPath, async (req, res, next) => {
    try {
      const configuredHash = String(env.FLUTTERWAVE_WEBHOOK_SECRET_HASH || "").trim();
      const receivedHash = String(req.headers["verif-hash"] || "").trim();

      if (!configuredHash || !receivedHash || receivedHash !== configuredHash) {
        logger.warn("Flutterwave webhook rejected: invalid signature");
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      const body = req.body || {};
      const event = String(body.event || "").trim();
      const transactionId = String((body.data && body.data.id) || "").trim();

      if (event !== "charge.completed" || !transactionId) {
        res.status(200).json({ received: true, handled: false });
        return;
      }

      if (!flutterwaveService || !flutterwaveService.isConfigured) {
        logger.warn("Flutterwave webhook received but service is not configured");
        res.status(200).json({ received: true, handled: false });
        return;
      }

      const verified = await flutterwaveService.verifyTransaction(transactionId);
      if (!verified || verified.status !== "successful") {
        logger.warn("Flutterwave transaction verification failed or not successful", {
          transactionId,
          status: verified && verified.status,
        });
        res.status(200).json({ received: true, handled: false });
        return;
      }

      const meta = verified.meta || {};
      const restaurantId = String(meta.restaurantId || "").trim();
      const purpose = String(meta.purpose || "").trim();
      const orderId = String(meta.orderId || "").trim();

      if (!restaurantId) {
        logger.warn("Flutterwave transaction verified but missing restaurantId in meta", {
          transactionId,
        });
        res.status(200).json({ received: true, handled: false });
        return;
      }

      const isNewTransaction = await billingTransactionRepo.recordIfNew(transactionId, {
        restaurantId,
        orderId,
        purpose,
        provider: "flutterwave",
        amount: Number(verified.amount) || 0,
        currency: String(verified.currency || "").trim().toUpperCase(),
        txRef: verified.tx_ref || "",
      });

      if (!isNewTransaction) {
        logger.info("Flutterwave webhook ignored duplicate transaction", { transactionId });
        res.status(200).json({ received: true, handled: false, duplicate: true });
        return;
      }

      const handled =
        purpose === "order_payment"
          ? await handleOrderPayment({ restaurantId, orderId, transactionId, verified })
          : await handleSubscriptionPayment({ restaurantId, transactionId, verified });

      res.status(200).json({ received: true, handled: Boolean(handled) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createFlutterwaveWebhookRoutes,
};
