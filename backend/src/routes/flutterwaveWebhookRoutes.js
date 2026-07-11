const { Router } = require("express");

function createFlutterwaveWebhookRoutes({
  env,
  logger,
  flutterwaveService,
  restaurantBillingService,
  billingTransactionRepo,
}) {
  const router = Router();
  const webhookPath = "/webhooks/flutterwave";

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

      const restaurantId = String(
        (verified.meta && verified.meta.restaurantId) || ""
      ).trim();

      if (!restaurantId) {
        logger.warn("Flutterwave transaction verified but missing restaurantId in meta", {
          transactionId,
        });
        res.status(200).json({ received: true, handled: false });
        return;
      }

      const expectedAmount = Number(env.SERVRA_BILLING_AMOUNT) || 0;
      const expectedCurrency = String(env.SERVRA_BILLING_CURRENCY || "NGN").trim().toUpperCase();
      const paidAmount = Number(verified.amount) || 0;
      const paidCurrency = String(verified.currency || "").trim().toUpperCase();

      if (paidCurrency !== expectedCurrency || paidAmount < expectedAmount) {
        logger.warn("Flutterwave transaction amount/currency mismatch", {
          transactionId,
          restaurantId,
          paidAmount,
          paidCurrency,
          expectedAmount,
          expectedCurrency,
        });
        res.status(200).json({ received: true, handled: false });
        return;
      }

      const isNewTransaction = await billingTransactionRepo.recordIfNew(transactionId, {
        restaurantId,
        provider: "flutterwave",
        amount: paidAmount,
        currency: paidCurrency,
        txRef: verified.tx_ref || "",
      });

      if (!isNewTransaction) {
        logger.info("Flutterwave webhook ignored duplicate transaction", { transactionId });
        res.status(200).json({ received: true, handled: false, duplicate: true });
        return;
      }

      await restaurantBillingService.confirmAutomaticPayment({
        restaurantId,
        provider: "flutterwave",
        transactionId,
        amount: paidAmount,
        currency: paidCurrency,
        txRef: verified.tx_ref || "",
      });

      logger.info("Flutterwave subscription payment confirmed", {
        restaurantId,
        transactionId,
      });

      res.status(200).json({ received: true, handled: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createFlutterwaveWebhookRoutes,
};
