const { normalizeText } = require("../utils/text");
const { ORDER_STATUSES } = require("../constants/orderStatuses");
const {
  buildMenuWelcome,
  buildInvalidOrderMessage,
  buildOrderReceivedMessage,
  buildNoPendingCancelMessage,
} = require("../templates/messages");

function buildProviderMessageId(normalized) {
  if (normalized.providerMessageId) {
    return String(normalized.providerMessageId);
  }

  return `${normalized.channelCustomerId}:${normalized.timestamp || Date.now()}:${normalized.text || ""}`;
}

function normalizeInboundInput(channel, input = {}) {
  return {
    channel: String(channel || "whatsapp-web"),
    channelCustomerId: String(input.channelCustomerId || "").trim(),
    customerPhone: String(input.customerPhone || "").trim(),
    displayName: String(input.displayName || "").trim(),
    text: String(input.text || ""),
    providerMessageId: String(input.providerMessageId || "").trim(),
    timestamp: Number(input.timestamp) || Date.now(),
  };
}

function createInboundMessageService({
  inboundEventRepo,
  menuService,
  customerService,
  orderService,
  channelGateway,
  logger,
  menuCooldownMs,
}) {
  const menuCooldownByChat = new Map();
  const effectiveMenuCooldownMs =
    Number(menuCooldownMs) > 0 ? Number(menuCooldownMs) : 90 * 1000;

  function shouldThrottleMenuReply({ restaurantId, channelCustomerId }) {
    const key = `${restaurantId}:${channelCustomerId}`;
    const now = Date.now();

    for (const [cacheKey, expiresAt] of menuCooldownByChat.entries()) {
      if (expiresAt <= now) {
        menuCooldownByChat.delete(cacheKey);
      }
    }

    const existing = menuCooldownByChat.get(key);
    if (existing && existing > now) {
      return true;
    }

    menuCooldownByChat.set(key, now + effectiveMenuCooldownMs);
    return false;
  }

  async function processInbound({ restaurantId, normalized, sendMessage }) {
    const providerMessageId = buildProviderMessageId(normalized);

    const isNew = await inboundEventRepo.markInboundEventIfNew({
      restaurantId,
      providerMessageId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
      customerPhone: normalized.customerPhone,
    });

    if (!isNew) {
      logger.info("Skipping duplicate inbound message", {
        restaurantId,
        channel: normalized.channel,
        providerMessageId,
      });

      return {
        handled: true,
        duplicate: true,
        shouldReply: false,
        type: "duplicate",
      };
    }

    const customer = await customerService.upsertCustomerFromChannelMessage({
      restaurantId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
      customerPhone: normalized.customerPhone,
      displayName: normalized.displayName || "",
    });

    const incomingMessage = normalized.text || "";
    const lower = normalizeText(incomingMessage);

    const activeOrder = await orderService.findActiveOrderByCustomer({
      restaurantId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
    });

    if (activeOrder && incomingMessage.trim()) {
      await orderService.logInboundMessage(activeOrder, incomingMessage, {
        providerMessageId,
      });
    }

    if (!incomingMessage.trim()) {
      return {
        handled: true,
        shouldReply: false,
        type: "empty_message",
      };
    }

    if (lower === "hi" || lower === "hello" || lower === "menu") {
      if (
        shouldThrottleMenuReply({
          restaurantId,
          channelCustomerId: normalized.channelCustomerId,
        })
      ) {
        return {
          handled: true,
          shouldReply: false,
          type: "menu_cooldown",
        };
      }

      const menuItems = await menuService.listAvailableMenuItems(restaurantId);
      const replyText = buildMenuWelcome(menuItems);

      if (sendMessage) {
        await sendMessage({
          to: normalized.channelCustomerId,
          text: replyText,
        });
      }

      return {
        handled: true,
        shouldReply: true,
        type: "menu",
        replyText,
      };
    }

    if (activeOrder && activeOrder.status === ORDER_STATUSES.AWAITING_CUSTOMER_UPDATE) {
      const result = await orderService.handleAwaitingCustomerUpdate({
        restaurantId,
        activeOrder,
        incomingMessage,
      });

      if (result && result.handled) {
        if (sendMessage) {
          await orderService.sendMessageToOrderCustomer(result.order, result.reply, {
            type: "awaiting_customer_update_reply",
            sourceAction: "customerAwaitingUpdateReply",
            sourceRef: result.order && result.order.id ? result.order.id : "",
            providerMessageId,
          });
        }

        return {
          handled: true,
          shouldReply: true,
          type: "awaiting_customer_update",
          replyText: result.reply,
          orderId: result.order && result.order.id,
        };
      }
    }

    if (activeOrder && activeOrder.status === ORDER_STATUSES.AWAITING_CUSTOMER_EDIT) {
      const result = await orderService.handleAwaitingCustomerEdit({
        restaurantId,
        activeOrder,
        incomingMessage,
      });

      if (result && result.handled) {
        if (sendMessage) {
          await orderService.sendMessageToOrderCustomer(result.order, result.reply, {
            type: "awaiting_customer_edit_reply",
            sourceAction: "customerAwaitingEditReply",
            sourceRef: result.order && result.order.id ? result.order.id : "",
            providerMessageId,
          });
        }

        return {
          handled: true,
          shouldReply: true,
          type: "awaiting_customer_edit",
          replyText: result.reply,
          orderId: result.order && result.order.id,
        };
      }
    }

    if (lower === "cancel") {
      const replyText = buildNoPendingCancelMessage();
      if (sendMessage) {
        await sendMessage({
          to: normalized.channelCustomerId,
          text: replyText,
        });
      }

      return {
        handled: true,
        shouldReply: true,
        type: "cancel_noop",
        replyText,
      };
    }

    const order = await orderService.createNewOrderFromInbound({
      restaurantId,
      customer,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
      customerPhone: normalized.customerPhone,
      messageText: incomingMessage,
      providerMessageId,
    });

    if (!order) {
      if (
        shouldThrottleMenuReply({
          restaurantId,
          channelCustomerId: normalized.channelCustomerId,
        })
      ) {
        return {
          handled: true,
          shouldReply: false,
          type: "invalid_order_cooldown",
        };
      }

      const menuItems = await menuService.listAvailableMenuItems(restaurantId);
      const replyText = buildInvalidOrderMessage(menuItems);

      if (sendMessage) {
        await sendMessage({
          to: normalized.channelCustomerId,
          text: replyText,
        });
      }

      return {
        handled: true,
        shouldReply: true,
        type: "invalid_order",
        replyText,
      };
    }

    await orderService.logInboundMessage(order, incomingMessage, {
      providerMessageId,
    });

    const replyText = buildOrderReceivedMessage({
      matched: order.matched,
      total: order.total,
      unavailable: order.unavailable,
    });

    if (sendMessage) {
      await orderService.sendMessageToOrderCustomer(order, replyText, {
        type: "order_created",
        sourceAction: "inboundOrderCreatedReply",
        sourceRef: order.id,
        providerMessageId,
      });
    }

    return {
      handled: true,
      shouldReply: true,
      type: "order_created",
      orderId: order.id,
      replyText,
    };
  }

  async function handleInboundEvent({ restaurantId, channel, rawEvent }) {
    const normalized = normalizeInboundInput(
      channel,
      channelGateway.normalizeInboundMessage({ channel, rawEvent })
    );

    return processInbound({
      restaurantId,
      normalized,
      sendMessage: ({ to, text }) =>
        channelGateway.sendMessage({
          channel,
          restaurantId,
          to,
          text,
        }),
    });
  }

  async function handleInboundNormalized({ restaurantId, message, sendMessage = null }) {
    const normalized = normalizeInboundInput(message.channel, message);

    return processInbound({
      restaurantId,
      normalized,
      sendMessage,
    });
  }

  return {
    handleInboundEvent,
    handleInboundNormalized,
  };
}

module.exports = {
  createInboundMessageService,
};
