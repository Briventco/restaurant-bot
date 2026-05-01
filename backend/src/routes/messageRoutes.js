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

function normalizeStaffCommand(body) {
  return {
    channel: String(body.channel || "whatsapp-web"),
    channelCustomerId: String(body.channelCustomerId || "").trim(),
    customerPhone: String(body.customerPhone || "").trim(),
    displayName: String(body.displayName || "").trim(),
    command: String(body.command || ""),
    providerMessageId: String(body.providerMessageId || "").trim(),
    timestamp: Number(body.timestamp) || Date.now(),
    type: String(body.type || "chat"),
    isFromMe: Boolean(body.isFromMe),
    isStatus: Boolean(body.isStatus),
    isBroadcast: Boolean(body.isBroadcast),
  };
}

function parseStaffCommand(commandText) {
  const trimmed = String(commandText || "").trim();
  if (!trimmed.startsWith('#')) {
    return null;
  }

  const parts = trimmed.slice(1).trim().split(/\s+/);
  if (parts.length === 0) {
    return null;
  }

  const action = parts[0].toLowerCase();
  const orderId = parts[1] || "";
  const reason = parts.slice(2).join(' ') || '';

  return {
    action,
    orderId,
    reason,
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
  menuService,
  orderParsingService,
  restaurantRepo,
  orderService,
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
    "/messages/interpret",
    requireApiKey({
      anyOf: ["messages.inbound", "orders.read"],
    }),
    requireRestaurantAccess,
    validateBody({
      text: { required: true, type: "string", minLength: 1 },
    }),
    async (req, res, next) => {
      try {
        const menuItems = await menuService.listMenuItems(req.restaurantId);
        const interpretation = await orderParsingService.interpretCustomerMessage(
          req.body.text,
          menuItems
        );

        logger.info("Structured message interpretation generated", {
          restaurantId: req.restaurantId,
          intent: interpretation.intent,
          quantity: interpretation.quantity,
          clarificationNeeded: interpretation.clarificationNeeded,
        });

        res.status(200).json(interpretation);
      } catch (error) {
        next(error);
      }
    }
  );

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

  router.post(
    "/messages/staff-command",
    requireRuntimeKeyOrApiKey,
    requireRestaurantAccess,
    validateBody({
      channel: { required: true, type: "string" },
      channelCustomerId: { required: true, type: "string" },
      customerPhone: { required: false, type: "string" },
      displayName: { required: false, type: "string" },
      command: { required: true, type: "string" },
      providerMessageId: { required: false, type: "string" },
      timestamp: { required: false, type: "number" },
      type: { required: false, type: "string" },
      isFromMe: { required: false, type: "boolean" },
      isStatus: { required: false, type: "boolean" },
      isBroadcast: { required: false, type: "boolean" },
    }),
    async (req, res, next) => {
      try {
        const command = normalizeStaffCommand(req.body || {});
        const parsed = parseStaffCommand(command.command);

        logger.info("Staff command received", {
          restaurantId: req.restaurantId,
          channel: command.channel,
          channelCustomerId: command.channelCustomerId,
          command: command.command,
          parsed,
        });

        if (!parsed) {
          res.status(200).json({
            handled: true,
            shouldReply: true,
            replyText: "Invalid command format. Use: #confirm ORDER_ID or #reject ORDER_ID reason",
            type: "invalid_command",
          });
          return;
        }

        if (!['confirm', 'reject'].includes(parsed.action)) {
          res.status(200).json({
            handled: true,
            shouldReply: true,
            replyText: "Unknown command. Use: #confirm ORDER_ID or #reject ORDER_ID reason",
            type: "unknown_command",
          });
          return;
        }

        if (!parsed.orderId) {
          res.status(200).json({
            handled: true,
            shouldReply: true,
            replyText: "Missing order ID. Use: #confirm ORDER_ID or #reject ORDER_ID reason",
            type: "missing_order_id",
          });
          return;
        }

        try {
          const actor = {
            type: "staff",
            id: command.channelCustomerId,
          };

          if (parsed.action === 'confirm') {
            await orderService.confirmOrder({
              restaurantId: req.restaurantId,
              orderId: parsed.orderId,
              actor,
            });
            logger.info("Order confirmed via staff command", {
              restaurantId: req.restaurantId,
              orderId: parsed.orderId,
              staffId: command.channelCustomerId,
            });
            res.status(200).json({
              handled: true,
              shouldReply: true,
              replyText: `Order ${parsed.orderId} confirmed. Customer will be notified.`,
              type: "order_confirmed",
            });
          } else if (parsed.action === 'reject') {
            await orderService.rejectOrder({
              restaurantId: req.restaurantId,
              orderId: parsed.orderId,
              actor,
              note: parsed.reason,
            });
            logger.info("Order rejected via staff command", {
              restaurantId: req.restaurantId,
              orderId: parsed.orderId,
              staffId: command.channelCustomerId,
              reason: parsed.reason,
            });
            res.status(200).json({
              handled: true,
              shouldReply: true,
              replyText: `Order ${parsed.orderId} rejected. Reason: ${parsed.reason || 'Not specified'}. Customer will be notified.`,
              type: "order_rejected",
            });
          }
        } catch (error) {
          logger.error("Staff command execution failed", {
            restaurantId: req.restaurantId,
            action: parsed.action,
            orderId: parsed.orderId,
            error: error.message,
          });
          res.status(200).json({
            handled: true,
            shouldReply: true,
            replyText: `Failed to ${parsed.action} order: ${error.message}`,
            type: "command_failed",
          });
        }
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
