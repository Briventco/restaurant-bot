function createHealthAlertService({ env, logger }) {
  async function sendWebhookAlert(payload) {
    const webhookUrl = String(env.RESTAURANT_HEALTH_ALERT_WEBHOOK_URL || "").trim();
    if (!webhookUrl) {
      return { delivered: false, channel: "webhook", skipped: true };
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn("Health alert webhook returned non-success", {
          status: response.status,
          bodyPreview: String(text || "").slice(0, 200),
        });
        return { delivered: false, channel: "webhook", skipped: false };
      }

      return { delivered: true, channel: "webhook", skipped: false };
    } catch (error) {
      logger.error("Health alert webhook failed", {
        message: error.message,
        stack: error.stack,
      });
      return { delivered: false, channel: "webhook", skipped: false };
    }
  }

  async function sendHealthTransitionAlert({
    restaurantId,
    restaurantName,
    previousStatus,
    currentStatus,
    issueCodes,
    lifecyclePolicyCode,
  }) {
    const payload = {
      type: "restaurant.health.transition",
      restaurantId,
      restaurantName: String(restaurantName || "").trim() || restaurantId,
      previousStatus: String(previousStatus || "").trim().toLowerCase() || "unknown",
      currentStatus: String(currentStatus || "").trim().toLowerCase() || "unknown",
      issueCodes: Array.isArray(issueCodes) ? issueCodes : [],
      lifecyclePolicyCode: String(lifecyclePolicyCode || "").trim().toUpperCase() || "NOOP",
      timestamp: new Date().toISOString(),
    };

    const deliveries = [];

    if (payload.currentStatus === "critical") {
      logger.error("Restaurant health alert", payload);
    } else if (payload.currentStatus === "degraded") {
      logger.warn("Restaurant health alert", payload);
    } else {
      logger.info("Restaurant health alert", payload);
    }

    deliveries.push(await sendWebhookAlert(payload));
    return {
      payload,
      deliveries,
    };
  }

  return {
    sendHealthTransitionAlert,
  };
}

module.exports = {
  createHealthAlertService,
};
