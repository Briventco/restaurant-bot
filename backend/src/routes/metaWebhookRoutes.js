const { Router } = require("express");
const { sanitizePhoneFromWhatsappId } = require("../domain/utils/text");
const { evaluateRestaurantInboundPolicy } = require("./messageRoutes");

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function createMetaWebhookRoutes({
  env,
  logger,
  restaurantRepo,
  inboundMessageService,
  channelGateway,
}) {
  const router = Router();
  const callbackPath = env.META_WEBHOOK_PATH || "/webhooks/meta/whatsapp";

  function getDefaultRestaurantId() {
    return String(
      env.META_WEBHOOK_DEFAULT_RESTAURANT_ID || env.BACKEND_DEFAULT_RESTAURANT_ID || ""
    ).trim();
  }

  function normalizeMetaMessage(changeValue, message) {
    const contacts = toArray(changeValue && changeValue.contacts);
    const contact = contacts[0] || {};
    const channelCustomerId = String(message.from || "").trim();
    const timestampMs = Number(message.timestamp || 0) * 1000 || Date.now();
    const textBody =
      message && message.type === "text" && message.text && message.text.body
        ? String(message.text.body)
        : "";

    return {
      channel: "whatsapp-web",
      channelCustomerId,
      customerPhone: sanitizePhoneFromWhatsappId(channelCustomerId),
      displayName:
        (contact.profile && String(contact.profile.name || "").trim()) || "",
      text: textBody,
      providerMessageId: String(message.id || "").trim(),
      timestamp: timestampMs,
      type: message && message.type === "text" ? "chat" : String(message.type || "chat"),
      isFromMe: false,
      isStatus: false,
      isBroadcast: false,
    };
  }

  router.get(callbackPath, (req, res) => {
    if (!env.META_WEBHOOK_ENABLED) {
      res.status(404).json({ error: "Meta webhook is disabled" });
      return;
    }

    const mode = String(req.query["hub.mode"] || "").trim();
    const verifyToken = String(req.query["hub.verify_token"] || "").trim();
    const challenge = String(req.query["hub.challenge"] || "").trim();

    if (
      mode === "subscribe" &&
      verifyToken &&
      verifyToken === String(env.META_VERIFY_TOKEN || "").trim()
    ) {
      logger.info("Meta webhook verified", {
        callbackPath,
      });
      res.status(200).send(challenge);
      return;
    }

    logger.warn("Meta webhook verification failed", {
      callbackPath,
      mode,
    });
    res.status(403).json({ error: "Invalid webhook verification request" });
  });

  router.post(callbackPath, async (req, res, next) => {
    if (!env.META_WEBHOOK_ENABLED) {
      res.status(404).json({ error: "Meta webhook is disabled" });
      return;
    }

    try {
      const restaurantId = getDefaultRestaurantId();
      if (!restaurantId) {
        logger.warn("Meta webhook received without a default restaurant mapping", {
          callbackPath,
        });
        res.status(200).json({ received: true, handled: false, reason: "missing_restaurant" });
        return;
      }

      const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
      if (!restaurant) {
        logger.warn("Meta webhook received for unknown default restaurant", {
          callbackPath,
          restaurantId,
        });
        res.status(200).json({ received: true, handled: false, reason: "restaurant_not_found" });
        return;
      }

      const entries = toArray(req.body && req.body.entry);
      let handledCount = 0;

      for (const entry of entries) {
        const changes = toArray(entry && entry.changes);
        for (const change of changes) {
          const value = change && change.value ? change.value : {};
          const messages = toArray(value.messages);

          for (const message of messages) {
            if (String(message.type || "") !== "text") {
              logger.info("Meta webhook ignored non-text message", {
                restaurantId,
                messageType: String(message.type || ""),
              });
              continue;
            }

            const inbound = normalizeMetaMessage(value, message);
            const policy = evaluateRestaurantInboundPolicy(restaurant, inbound);

            if (!policy.allowed) {
              logger.info("Meta inbound ignored by restaurant policy", {
                restaurantId,
                channelCustomerId: inbound.channelCustomerId,
                reason: policy.reason,
                providerMessageId: inbound.providerMessageId,
              });
              continue;
            }

            logger.info("Meta inbound webhook received", {
              restaurantId,
              channelCustomerId: inbound.channelCustomerId,
              providerMessageId: inbound.providerMessageId,
            });

            await inboundMessageService.handleInboundNormalized({
              restaurantId,
              message: inbound,
              sendMessage: ({ to, text }) =>
                channelGateway.sendMessage({
                  channel: inbound.channel,
                  restaurantId,
                  to,
                  text,
                }),
            });

            handledCount += 1;
          }
        }
      }

      res.status(200).json({
        received: true,
        handled: handledCount > 0,
        handledCount,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createMetaWebhookRoutes,
};
