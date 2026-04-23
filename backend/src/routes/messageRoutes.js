const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");

const SUPPORTED_INBOUND_TYPES = new Set(["chat", "text"]);

function toDigits(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function toList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeInbound(body) {
  return {
    channel: String(body.channel || "whatsapp-web"),
    channelCustomerId: String(body.channelCustomerId || "").trim(),
    customerPhone: String(body.customerPhone || "").trim(),
    displayName: String(body.displayName || "").trim(),
    text: String(body.text || ""),
    providerMessageId: String(body.providerMessageId || "").trim(),
    timestamp: Number(body.timestamp) || Date.now(),
    type: String(body.type || "chat"),
    isFromMe: Boolean(body.isFromMe),
    isStatus: Boolean(body.isStatus),
    isBroadcast: Boolean(body.isBroadcast),
  };
}

function isGroupChat(channelCustomerId) {
  return String(channelCustomerId || "").endsWith("@g.us");
}

function evaluateRestaurantInboundPolicy(restaurant, inbound) {
  const bot = (restaurant && restaurant.bot) || {};

  if (bot.enabled === false) {
    return { allowed: false, reason: "bot_paused" };
  }

  if (inbound.isFromMe) {
    return { allowed: false, reason: "from_me" };
  }

  if (inbound.isStatus || inbound.channelCustomerId === "status@broadcast") {
    return { allowed: false, reason: "status_broadcast" };
  }

  if (inbound.isBroadcast || inbound.channelCustomerId.endsWith("@broadcast")) {
    return { allowed: false, reason: "broadcast" };
  }

  if (!SUPPORTED_INBOUND_TYPES.has(inbound.type)) {
    return { allowed: false, reason: `unsupported_type:${inbound.type}` };
  }

  if (!inbound.channelCustomerId) {
    return { allowed: false, reason: "missing_channel_customer_id" };
  }

  if (!inbound.text.trim()) {
    return { allowed: false, reason: "empty_message" };
  }

  const ignoreGroupChats = bot.ignoreGroupChats !== false;
  if (ignoreGroupChats && isGroupChat(inbound.channelCustomerId)) {
    return { allowed: false, reason: "group_chat" };
  }

  const allowedChannels = toList(bot.allowedChannels);
  if (allowedChannels.length && !allowedChannels.includes(inbound.channel)) {
    return { allowed: false, reason: "channel_not_allowed" };
  }

  const allowedChatIds = toList(bot.allowedChatIds);
  if (allowedChatIds.length && !allowedChatIds.includes(inbound.channelCustomerId)) {
    return { allowed: false, reason: "chat_not_allowed" };
  }

  const allowedPrefixes = toList(bot.allowedPhonePrefixes).map(toDigits).filter(Boolean);
  if (allowedPrefixes.length) {
    const phoneDigits = toDigits(inbound.customerPhone || inbound.channelCustomerId);
    const matched = allowedPrefixes.some((prefix) => phoneDigits.startsWith(prefix));

    if (!matched) {
      return { allowed: false, reason: "phone_prefix_not_allowed" };
    }
  }

  return { allowed: true, reason: "ok" };
}

function createMessageRoutes({
  requireApiKey,
  requireRestaurantAccess,
  inboundMessageService,
  restaurantRepo,
  env,
  logger,
}) {
  const router = Router({ mergeParams: true });
  const runtimeRegistryKey = String(
    env &&
      (env.BACKEND_RUNTIME_REGISTRY_KEY || env.WHATSAPP_RUNTIME_API_KEY || "")
  ).trim();

  async function requireRuntimeKeyOrApiKey(req, res, next) {
    const incomingRuntimeKey = String(req.header("x-runtime-key") || "").trim();
    if (runtimeRegistryKey && incomingRuntimeKey && incomingRuntimeKey === runtimeRegistryKey) {
      const restaurantId = String(req.params.restaurantId || "").trim();
      if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId in request path" });
        return;
      }

      const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      req.restaurantId = restaurantId;
      req.restaurant = restaurant;
      req.auth = {
        restaurantId,
        keyId: "runtime-registry-key",
        scopes: ["messages.inbound"],
      };
      next();
      return;
    }

    const middleware = requireApiKey(["messages.inbound"]);
    middleware(req, res, next);
  }

  router.post(
    "/messages/inbound",
    requireRuntimeKeyOrApiKey,
    requireRestaurantAccess,
    validateBody({
      channel: { required: true, type: "string" },
      channelCustomerId: { required: true, type: "string" },
      customerPhone: { required: false, type: "string" },
      displayName: { required: false, type: "string" },
      text: { required: false, type: "string" },
      providerMessageId: { required: false, type: "string" },
      timestamp: { required: false, type: "number" },
      type: { required: false, type: "string" },
      isFromMe: { required: false, type: "boolean" },
      isStatus: { required: false, type: "boolean" },
      isBroadcast: { required: false, type: "boolean" },
    }),
    async (req, res, next) => {
      try {
        const inbound = normalizeInbound(req.body || {});
        logger.info("Inbound handoff received", {
          restaurantId: req.restaurantId,
          channel: inbound.channel,
          channelCustomerId: inbound.channelCustomerId,
          providerMessageId: inbound.providerMessageId || "",
          type: inbound.type,
        });

        const policy = evaluateRestaurantInboundPolicy(req.restaurant, inbound);

        if (!policy.allowed) {
          logger.info("Inbound message ignored by restaurant policy", {
            restaurantId: req.restaurantId,
            channel: inbound.channel,
            channelCustomerId: inbound.channelCustomerId,
            reason: policy.reason,
          });

          res.status(200).json({
            handled: true,
            ignored: true,
            shouldReply: false,
            type: policy.reason,
          });
          return;
        }

        const result = await inboundMessageService.handleInboundNormalized({
          restaurantId: req.restaurantId,
          message: inbound,
        });

        logger.info("Inbound handoff processed", {
          restaurantId: req.restaurantId,
          channel: inbound.channel,
          channelCustomerId: inbound.channelCustomerId,
          providerMessageId: inbound.providerMessageId || "",
          type: result && result.type ? result.type : "unknown",
          shouldReply: Boolean(result && result.shouldReply),
          duplicate: Boolean(result && result.duplicate),
        });

        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createMessageRoutes,
  evaluateRestaurantInboundPolicy,
};
