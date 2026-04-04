const { normalizeText } = require("../utils/text");
const { ORDER_STATUSES } = require("../constants/orderStatuses");
const {
  buildMenuWelcome,
  buildInvalidOrderMessage,
  buildOrderReceivedMessage,
  buildNoPendingCancelMessage,
  buildSelectedItemPrompt,
  buildDeliveryOrPickupPrompt,
  buildAddressPrompt,
  buildGuidedConfirmPrompt,
  buildGuidedOrderConfirmedMessage,
} = require("../templates/messages");

const FLOW_STATES = {
  AWAITING_ITEM: "awaiting_item",
  AWAITING_QUANTITY: "awaiting_quantity",
  AWAITING_FULFILLMENT_TYPE: "awaiting_fulfillment_type",
  AWAITING_ADDRESS: "awaiting_address",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
};

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

function toPositiveInteger(value) {
  const parsed = Number(String(value || "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.max(1, Math.round(parsed));
}

function createInboundMessageService({
  inboundEventRepo,
  menuService,
  customerService,
  orderService,
  channelGateway,
  conversationSessionRepo,
  restaurantRepo,
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

  async function sendText(sendMessage, to, text) {
    if (!sendMessage) {
      return;
    }

    await sendMessage({
      to,
      text,
    });
  }

  async function beginGuidedOrderingFlow({
    restaurantId,
    normalized,
    restaurant,
    menuItems,
    sendMessage,
  }) {
    const replyText = buildMenuWelcome(menuItems, restaurant && restaurant.name);

    await conversationSessionRepo.upsertSession(
      restaurantId,
      normalized.channel,
      normalized.channelCustomerId,
      {
        state: FLOW_STATES.AWAITING_ITEM,
        restaurantName: String((restaurant && restaurant.name) || "").trim(),
      }
    );

    await sendText(sendMessage, normalized.channelCustomerId, replyText);

    return {
      handled: true,
      shouldReply: true,
      type: "guided_menu",
      replyText,
    };
  }

  function resolveMenuSelection(menuItems, incomingMessage) {
    const availableItems = (menuItems || []).filter((item) => item.available);
    const trimmed = String(incomingMessage || "").trim();
    const asNumber = Number(trimmed);

    if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= availableItems.length) {
      return availableItems[Math.round(asNumber) - 1] || null;
    }

    const lowered = normalizeText(trimmed);
    return (
      availableItems.find((item) => normalizeText(item.name) === lowered) ||
      availableItems.find((item) => normalizeText(item.name).includes(lowered)) ||
      null
    );
  }

  async function handleGuidedSession({
    restaurantId,
    normalized,
    session,
    customer,
    providerMessageId,
    sendMessage,
  }) {
    const lower = normalizeText(normalized.text);
    const menuItems = await menuService.listAvailableMenuItems(restaurantId);

    if (!menuItems.length) {
      const replyText = "Menu is currently unavailable. Please try again later.";
      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_menu_unavailable",
        replyText,
      };
    }

    if (session.state === FLOW_STATES.AWAITING_ITEM) {
      const selectedItem = resolveMenuSelection(menuItems, normalized.text);
      if (!selectedItem) {
        const replyText = buildMenuWelcome(
          menuItems,
          String(session.restaurantName || "").trim()
        );
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_item",
          replyText,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: FLOW_STATES.AWAITING_QUANTITY,
          itemId: selectedItem.id,
          itemName: selectedItem.name,
          itemPrice: Number(selectedItem.price) || 0,
        }
      );

      const replyText = buildSelectedItemPrompt(selectedItem);
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_quantity_prompt",
        replyText,
      };
    }

    if (session.state === FLOW_STATES.AWAITING_QUANTITY) {
      const quantity = toPositiveInteger(normalized.text);
      if (!quantity) {
        const replyText = "Please reply with a valid quantity, for example: 2";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_quantity",
          replyText,
        };
      }

      const total = Number(session.itemPrice || 0) * quantity;
      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: FLOW_STATES.AWAITING_FULFILLMENT_TYPE,
          quantity,
          total,
        }
      );

      const replyText = buildDeliveryOrPickupPrompt({
        itemName: session.itemName,
        quantity,
        total,
      });
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_fulfillment_prompt",
        replyText,
      };
    }

    if (session.state === FLOW_STATES.AWAITING_FULFILLMENT_TYPE) {
      let fulfillmentType = "";

      if (lower === "d" || lower === "delivery") {
        fulfillmentType = "delivery";
      } else if (lower === "p" || lower === "pickup") {
        fulfillmentType = "pickup";
      }

      if (!fulfillmentType) {
        const replyText = "Reply D for delivery or P for pickup.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_fulfillment",
          replyText,
        };
      }

      if (fulfillmentType === "delivery") {
        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: FLOW_STATES.AWAITING_ADDRESS,
            fulfillmentType,
          }
        );

        const replyText = buildAddressPrompt();
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_address_prompt",
          replyText,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: FLOW_STATES.AWAITING_CONFIRMATION,
          fulfillmentType,
          deliveryAddress: "",
        }
      );

      const replyText = buildGuidedConfirmPrompt({
        itemName: session.itemName,
        quantity: Number(session.quantity || 0),
        total: Number(session.total || 0),
        fulfillmentType,
        address: "",
      });
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_confirmation_prompt",
        replyText,
      };
    }

    if (session.state === FLOW_STATES.AWAITING_ADDRESS) {
      const address = String(normalized.text || "").trim();
      if (!address) {
        const replyText = buildAddressPrompt();
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_address",
          replyText,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: FLOW_STATES.AWAITING_CONFIRMATION,
          fulfillmentType: "delivery",
          deliveryAddress: address,
        }
      );

      const replyText = buildGuidedConfirmPrompt({
        itemName: session.itemName,
        quantity: Number(session.quantity || 0),
        total: Number(session.total || 0),
        fulfillmentType: "delivery",
        address,
      });
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_confirmation_prompt",
        replyText,
      };
    }

    if (session.state === FLOW_STATES.AWAITING_CONFIRMATION) {
      if (lower === "no" || lower === "n") {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );
        const replyText = "Order cancelled. Send HI to start again.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_cancelled",
          replyText,
        };
      }

      if (lower !== "yes" && lower !== "y") {
        const replyText = "Please reply YES to confirm or NO to cancel.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_confirmation",
          replyText,
        };
      }

      const menuItem =
        menuItems.find((item) => String(item.id) === String(session.itemId || "")) || null;
      if (!menuItem || !menuItem.available) {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );
        const replyText = "That item is no longer available. Send HI to start again.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_item_no_longer_available",
          replyText,
        };
      }

      const order = await orderService.createGuidedOrder({
        restaurantId,
        customer,
        channel: normalized.channel,
        channelCustomerId: normalized.channelCustomerId,
        customerPhone: normalized.customerPhone,
        providerMessageId,
        menuItem,
        quantity: Number(session.quantity || 0),
        fulfillmentType: String(session.fulfillmentType || "pickup"),
        deliveryAddress: String(session.deliveryAddress || "").trim(),
      });

      await orderService.logInboundMessage(order, normalized.text, {
        providerMessageId,
      });

      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );

      const replyText = buildGuidedOrderConfirmedMessage();
      await orderService.sendMessageToOrderCustomer(order, replyText, {
        type: "guided_order_confirmed",
        sourceAction: "guidedOrderConfirmed",
        sourceRef: order.id,
        providerMessageId,
      });

      return {
        handled: true,
        shouldReply: true,
        type: "guided_order_created",
        orderId: order.id,
        replyText,
      };
    }

    await conversationSessionRepo.clearSession(
      restaurantId,
      normalized.channel,
      normalized.channelCustomerId
    );

    return null;
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

    const existingSession = await conversationSessionRepo.getSession(
      restaurantId,
      normalized.channel,
      normalized.channelCustomerId
    );

    if (existingSession) {
      const guidedResult = await handleGuidedSession({
        restaurantId,
        normalized,
        session: existingSession,
        customer,
        providerMessageId,
        sendMessage,
      });

      if (guidedResult) {
        return guidedResult;
      }
    }

    if (lower === "hi" || lower === "hello" || lower === "menu" || lower === "start") {
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

      const [menuItems, restaurant] = await Promise.all([
        menuService.listAvailableMenuItems(restaurantId),
        restaurantRepo.getRestaurantById(restaurantId),
      ]);

      return beginGuidedOrderingFlow({
        restaurantId,
        normalized,
        restaurant,
        menuItems,
        sendMessage,
      });
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
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

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

      await sendText(sendMessage, normalized.channelCustomerId, replyText);

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
