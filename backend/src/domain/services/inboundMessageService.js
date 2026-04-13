const { normalizeText } = require("../utils/text");
const { ORDER_STATUSES } = require("../constants/orderStatuses");
const {
  buildMenuWelcome,
  buildGreetingMessage,
  buildStockAvailabilityMessage,
  buildInvalidOrderMessage,
  buildOrderReceivedMessage,
  buildOrderUpdatedMessage,
  buildNoPendingCancelMessage,
  buildSelectedItemPrompt,
  buildDeliveryOrPickupPrompt,
  buildAddressPrompt,
  buildGuidedConfirmPrompt,
  buildGuidedOrderConfirmedMessage,
  buildActiveOrderExistsMessage,
  buildPaymentReferenceSavedMessage,
  buildPaymentReviewAcknowledgedMessage,
  buildPaymentStillUnderReviewMessage,
  buildRestaurantOrderAlertHandledMessage,
  buildRestaurantContactCustomerMessage,
} = require("../templates/messages");

const FLOW_STATES = {
  AWAITING_ITEM: "awaiting_item",
  AWAITING_QUANTITY: "awaiting_quantity",
  AWAITING_FULFILLMENT_TYPE: "awaiting_fulfillment_type",
  AWAITING_ADDRESS: "awaiting_address",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  AWAITING_PAYMENT_REFERENCE: "awaiting_payment_reference",
  AWAITING_STAFF_ORDER_ACTION: "awaiting_staff_order_action",
};

const CUSTOMER_BLOCKING_ORDER_STATUSES = [
  ORDER_STATUSES.PENDING_CONFIRMATION,
  ORDER_STATUSES.CONFIRMED,
  ORDER_STATUSES.PREPARING,
];

function calculateMatchedTotal(matched) {
  return (matched || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
}

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
  const raw = String(value || "").trim();
  const directParsed = Number(raw);
  if (Number.isFinite(directParsed) && directParsed > 0) {
    return Math.max(1, Math.round(directParsed));
  }

  const match = raw.match(/\b(\d+)\b/);
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.max(1, Math.round(parsed));
}

function extractInlineQuantity(messageText) {
  const trimmed = String(messageText || "").trim();
  if (/^\d+$/.test(trimmed)) {
    return null;
  }

  const match = trimmed.match(/\b(\d+)\b/);
  if (!match) {
    return null;
  }

  return toPositiveInteger(match[1]);
}

function extractInlineFulfillmentType(messageText) {
  const lower = normalizeText(messageText);
  if (lower.includes("pickup") || lower === "p") {
    return "pickup";
  }
  if (lower.includes("delivery") || lower === "d") {
    return "delivery";
  }
  return "";
}

function extractInlineAddress(messageText) {
  const raw = String(messageText || "").trim();
  const match = raw.match(/\bdelivery(?:\s+to)?\s+(.+)$/i);
  if (!match || !match[1]) {
    return "";
  }

  return String(match[1]).trim();
}

function isGreetingText(lower) {
  return ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"].includes(
    lower
  );
}

function isMenuOrStockQuestion(lower) {
  return (
    lower === "menu" ||
    lower === "start" ||
    lower.includes("what do you have") ||
    lower.includes("what do you have in stock") ||
    lower.includes("in stock") ||
    lower.includes("available") ||
    lower.includes("what is available") ||
    lower.includes("show menu") ||
    lower.includes("show me the menu")
  );
}

function looksLikeNewOrderAttempt(lower) {
  return (
    lower.includes("i want") ||
    lower.includes("i would like") ||
    lower.includes("can i order") ||
    lower.includes("order ") ||
    lower.includes("buy ") ||
    lower.includes("get ")
  );
}

function looksLikePaymentReported(lower) {
  return (
    lower === "paid" ||
    lower === "payment made" ||
    lower === "payment sent" ||
    lower === "i have paid" ||
    lower === "i paid" ||
    lower.includes("i have paid") ||
    lower.includes("i paid") ||
    lower.includes("payment sent") ||
    lower.includes("payment done") ||
    lower.includes("transfer made") ||
    lower.includes("transfer done") ||
    lower.includes("sent proof") ||
    lower.includes("payment proof")
  );
}

function extractPaymentReferenceDetails(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return "";
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    const [, ...rest] = lines;
    const joined = rest.join(" ").trim();
    if (joined) {
      return joined;
    }
  }

  const stripped = text
    .replace(/i\s+have\s+paid/gi, "")
    .replace(/payment\s+sent/gi, "")
    .replace(/payment\s+made/gi, "")
    .replace(/payment\s+done/gi, "")
    .replace(/transfer\s+made/gi, "")
    .replace(/transfer\s+done/gi, "")
    .replace(/sent\s+proof/gi, "")
    .replace(/payment\s+proof/gi, "")
    .replace(/paid/gi, "")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .trim();

  return stripped;
}

function normalizePhoneLike(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function looksLikeQuestion(lower, rawText) {
  const text = String(rawText || "").trim();
  return (
    text.includes("?") ||
    lower.startsWith("do you") ||
    lower.startsWith("can you") ||
    lower.startsWith("what") ||
    lower.startsWith("which") ||
    lower.startsWith("how") ||
    lower.startsWith("is ") ||
    lower.startsWith("are ")
  );
}

function extractBudgetAmount(rawText) {
  const text = String(rawText || "");
  const match = text.match(/(?:under|below|less than)\s*(?:n|₦)?\s*(\d+)/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildInlineAvailableItems(menuItems) {
  return (menuItems || [])
    .filter((item) => item.available)
    .map((item) => `${item.name} (N${item.price})`)
    .join(", ");
}

function buildQuestionFallbackReply(lower, rawText, menuItems) {
  const availableItems = (menuItems || []).filter((item) => item.available);
  const availableText = buildInlineAvailableItems(availableItems);

  if (lower.startsWith("do you have")) {
    return availableItems.length
      ? `We don't currently have that listed on the menu. Right now we have ${availableText}.`
      : "I don't have any available items listed right now.";
  }

  if (lower.includes("recommend")) {
    const sorted = [...availableItems].sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    if (!sorted.length) {
      return "I don't have any available items listed right now.";
    }

    return `I'd recommend ${sorted[0].name} at N${sorted[0].price}. We also have ${availableText}.`;
  }

  const budget = extractBudgetAmount(rawText);
  if (budget) {
    const withinBudget = availableItems.filter((item) => Number(item.price || 0) <= budget);
    if (!withinBudget.length) {
      return `I don't currently have anything under N${budget}. Right now we have ${availableText}.`;
    }

    const withinBudgetText = withinBudget
      .map((item) => `${item.name} (N${item.price})`)
      .join(", ");
    return `You can get these within N${budget}: ${withinBudgetText}.`;
  }

  return availableItems.length
    ? `Right now we have ${availableText}. You can also ask about delivery or place an order whenever you're ready.`
    : "I can help with the menu, ordering, delivery, and item availability.";
}

function getDirectReplyThreshold(intent) {
  return [
    "stock_request",
    "availability_question",
    "recommendation",
    "price_question",
    "delivery_question",
    "support",
    "off_topic",
    "unknown",
    "greeting",
  ].includes(String(intent || "").trim())
    ? 0.35
    : 0.5;
}

function mentionsMultipleMenuItems(menuItems, incomingMessage) {
  const lowered = normalizeText(incomingMessage);
  const matchedNames = (menuItems || [])
    .filter((item) => item.available)
    .filter((item) => lowered.includes(normalizeText(item.name)));

  return matchedNames.length > 1;
}

function buildMatchedFromSession(session) {
  if (Array.isArray(session.matched) && session.matched.length) {
    return session.matched;
  }

  if (!session.itemId || !session.itemName) {
    return [];
  }

  const quantity = Number(session.quantity || 0);
  const price = Number(session.itemPrice || 0);
  const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;

  return [
    {
      menuItemId: session.itemId,
      name: session.itemName,
      price,
      quantity: safeQuantity,
      subtotal: price * safeQuantity,
    },
  ];
}

function mergeMatchedItems(existingMatched, itemsToAdd) {
  const merged = Array.isArray(existingMatched)
    ? existingMatched.map((item) => ({ ...item }))
    : [];

  for (const item of itemsToAdd || []) {
    const existing = merged.find(
      (candidate) => String(candidate.menuItemId || "") === String(item.menuItemId || "")
    );

    if (existing) {
      existing.quantity = Number(existing.quantity || 0) + Number(item.quantity || 0);
      existing.subtotal = Number(existing.price || 0) * Number(existing.quantity || 0);
      continue;
    }

    merged.push({ ...item });
  }

  return merged;
}

function removeMatchedItems(existingMatched, itemsToRemove) {
  const idsToRemove = new Set(
    (itemsToRemove || []).map((item) => String(item.menuItemId || "")).filter(Boolean)
  );

  return (existingMatched || []).filter(
    (item) => !idsToRemove.has(String(item.menuItemId || ""))
  );
}

function looksLikeAddIntent(lower) {
  return lower.startsWith("add ") || lower.includes(" add ");
}

function looksLikeRemoveIntent(lower) {
  return (
    lower.startsWith("remove ") ||
    lower.includes(" remove ") ||
    lower.startsWith("without ") ||
    lower.includes(" without ")
  );
}

function looksLikeFulfillmentChange(lower) {
  return (
    lower.includes("change to pickup") ||
    lower.includes("change it to pickup") ||
    lower.includes("make it pickup") ||
    lower.includes("for pickup") ||
    lower.includes("change to delivery") ||
    lower.includes("change it to delivery") ||
    lower.includes("make it delivery") ||
    lower.includes("for delivery")
  );
}

function createInboundMessageService({
  inboundEventRepo,
  menuService,
  customerService,
  orderService,
  channelGateway,
  conversationSessionRepo,
  restaurantRepo,
  paymentService,
  llmService,
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

  function isRestaurantStaffAlertSender(restaurant, normalized) {
    const bot =
      restaurant && restaurant.bot && typeof restaurant.bot === "object"
        ? restaurant.bot
        : {};
    const recipients = Array.isArray(bot.orderAlertRecipients) ? bot.orderAlertRecipients : [];
    const incomingCandidates = [
      normalizePhoneLike(normalized.channelCustomerId),
      normalizePhoneLike(normalized.customerPhone),
    ].filter(Boolean);

    if (!incomingCandidates.length) {
      return false;
    }

    return recipients.some((recipient) => {
      const normalizedRecipient = normalizePhoneLike(recipient);
      return normalizedRecipient && incomingCandidates.includes(normalizedRecipient);
    });
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

  async function maybeHandleWithLlm({
    restaurantId,
    normalized,
    restaurant,
    menuItems,
    sendMessage,
    allowGuidedFlow = true,
  }) {
    if (!llmService) {
      return null;
    }

    const decision = await llmService.classifyRestaurantMessage({
      restaurant,
      menuItems,
      messageText: normalized.text,
    });

    if (
      allowGuidedFlow &&
      (decision.shouldStartGuidedFlow ||
        (decision.intent === "menu_request" && decision.confidence >= 0.5))
    ) {
      return beginGuidedOrderingFlow({
        restaurantId,
        normalized,
        restaurant,
        menuItems,
        sendMessage,
      });
    }

    if (
      decision.shouldHandleDirectly &&
      decision.replyText &&
      decision.confidence >= getDirectReplyThreshold(decision.intent) &&
      [
        "delivery_question",
        "support",
        "unknown",
        "greeting",
        "stock_request",
        "availability_question",
        "recommendation",
        "price_question",
        "off_topic",
      ].includes(decision.intent)
    ) {
      await sendText(sendMessage, normalized.channelCustomerId, decision.replyText);
      return {
        handled: true,
        shouldReply: true,
        type: `llm_${decision.intent}`,
        replyText: decision.replyText,
      };
    }

    return null;
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
      availableItems.find((item) => lowered.includes(normalizeText(item.name))) ||
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
      const { matched: requestedMatched } = await orderService.resolveRequestedItems({
        restaurantId,
        messageText: normalized.text,
      });
      if (requestedMatched.length > 1) {
        const inlineFulfillmentType = extractInlineFulfillmentType(normalized.text);
        const inlineAddress =
          inlineFulfillmentType === "delivery"
            ? extractInlineAddress(normalized.text)
            : "";
        const cartTotal = calculateMatchedTotal(requestedMatched);

        if (inlineFulfillmentType === "pickup") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_CONFIRMATION,
              matched: requestedMatched,
              total: cartTotal,
              fulfillmentType: "pickup",
              deliveryAddress: "",
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            matched: requestedMatched,
            total: cartTotal,
            fulfillmentType: "pickup",
            address: "",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery" && inlineAddress) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_CONFIRMATION,
              matched: requestedMatched,
              total: cartTotal,
              fulfillmentType: "delivery",
              deliveryAddress: inlineAddress,
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            matched: requestedMatched,
            total: cartTotal,
            fulfillmentType: "delivery",
            address: inlineAddress,
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_ADDRESS,
              matched: requestedMatched,
              total: cartTotal,
              fulfillmentType: "delivery",
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
            state: FLOW_STATES.AWAITING_FULFILLMENT_TYPE,
            matched: requestedMatched,
            total: cartTotal,
          }
        );

        const replyText = buildDeliveryOrPickupPrompt({
          matched: requestedMatched,
          total: cartTotal,
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "guided_multi_item_fulfillment_prompt",
          replyText,
        };
      }

      const selectedItem = resolveMenuSelection(menuItems, normalized.text);
      if (!selectedItem) {
        if (looksLikeQuestion(lower, normalized.text)) {
          const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
          const llmResult = await maybeHandleWithLlm({
            restaurantId,
            normalized,
            restaurant,
            menuItems,
            sendMessage,
            allowGuidedFlow: false,
          });

          if (llmResult) {
            return llmResult;
          }
        }

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

      const inlineQuantity = extractInlineQuantity(normalized.text);
      const inlineFulfillmentType = extractInlineFulfillmentType(normalized.text);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(normalized.text)
          : "";

      if (inlineQuantity) {
        const total = (Number(selectedItem.price) || 0) * inlineQuantity;

        if (inlineFulfillmentType === "pickup") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_CONFIRMATION,
              itemId: selectedItem.id,
              itemName: selectedItem.name,
              itemPrice: Number(selectedItem.price) || 0,
              quantity: inlineQuantity,
              total,
              fulfillmentType: "pickup",
              deliveryAddress: "",
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            itemName: selectedItem.name,
            quantity: inlineQuantity,
            total,
            fulfillmentType: "pickup",
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

        if (inlineFulfillmentType === "delivery" && inlineAddress) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_CONFIRMATION,
              itemId: selectedItem.id,
              itemName: selectedItem.name,
              itemPrice: Number(selectedItem.price) || 0,
              quantity: inlineQuantity,
              total,
              fulfillmentType: "delivery",
              deliveryAddress: inlineAddress,
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            itemName: selectedItem.name,
            quantity: inlineQuantity,
            total,
            fulfillmentType: "delivery",
            address: inlineAddress,
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_ADDRESS,
              itemId: selectedItem.id,
              itemName: selectedItem.name,
              itemPrice: Number(selectedItem.price) || 0,
              quantity: inlineQuantity,
              total,
              fulfillmentType: "delivery",
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
            state: FLOW_STATES.AWAITING_FULFILLMENT_TYPE,
            itemId: selectedItem.id,
            itemName: selectedItem.name,
            itemPrice: Number(selectedItem.price) || 0,
            quantity: inlineQuantity,
            total,
          }
        );

        const replyText = buildDeliveryOrPickupPrompt({
          itemName: selectedItem.name,
          quantity: inlineQuantity,
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
        matched: Array.isArray(session.matched) ? session.matched : null,
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
        matched: Array.isArray(session.matched) ? session.matched : null,
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
      const sessionMatched = buildMatchedFromSession(session);
      const inlineFulfillmentType = extractInlineFulfillmentType(normalized.text);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(normalized.text)
          : "";
      const lowerText = normalizeText(normalized.text);

      if (looksLikeAddIntent(lowerText) || looksLikeRemoveIntent(lowerText) || looksLikeFulfillmentChange(lowerText)) {
        const { matched: requestedMatched } = await orderService.resolveRequestedItems({
          restaurantId,
          messageText: normalized.text,
        });

        let nextMatched = sessionMatched;
        if (looksLikeAddIntent(lowerText) && requestedMatched.length) {
          nextMatched = mergeMatchedItems(sessionMatched, requestedMatched);
        } else if (looksLikeRemoveIntent(lowerText) && requestedMatched.length) {
          nextMatched = removeMatchedItems(sessionMatched, requestedMatched);
        }

        if (!nextMatched.length) {
          await conversationSessionRepo.clearSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId
          );
          const replyText = "Your draft order is now empty. Send HI whenever you want to start a new order.";
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_order_emptied",
            replyText,
          };
        }

        const nextTotal = calculateMatchedTotal(nextMatched);
        const nextFulfillmentType =
          inlineFulfillmentType || String(session.fulfillmentType || "").trim() || "";
        const nextAddress =
          nextFulfillmentType === "delivery"
            ? inlineAddress || String(session.deliveryAddress || "").trim()
            : "";

        if (nextFulfillmentType === "delivery" && !nextAddress) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_ADDRESS,
              matched: nextMatched,
              total: nextTotal,
              fulfillmentType: "delivery",
              deliveryAddress: "",
              itemId: "",
              itemName: "",
              itemPrice: 0,
              quantity: 0,
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

        if (!nextFulfillmentType) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_FULFILLMENT_TYPE,
              matched: nextMatched,
              total: nextTotal,
              itemId: "",
              itemName: "",
              itemPrice: 0,
              quantity: 0,
            }
          );

          const replyText = buildDeliveryOrPickupPrompt({
            matched: nextMatched,
            total: nextTotal,
            prefix: "Okay, I've updated your order.",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_fulfillment_prompt",
            replyText,
          };
        }

        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: FLOW_STATES.AWAITING_CONFIRMATION,
            matched: nextMatched,
            total: nextTotal,
            fulfillmentType: nextFulfillmentType,
            deliveryAddress: nextAddress,
            itemId: "",
            itemName: "",
            itemPrice: 0,
            quantity: 0,
          }
        );

        const replyText = buildGuidedConfirmPrompt({
          matched: nextMatched,
          total: nextTotal,
          fulfillmentType: nextFulfillmentType,
          address: nextAddress,
          prefix: "Okay, I've updated your order.",
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_order_updated",
          replyText,
        };
      }

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

      if (sessionMatched.length) {
        const hasUnavailableItem = sessionMatched.some((sessionItem) => {
          const liveMenuItem = menuItems.find(
            (item) => String(item.id) === String(sessionItem.menuItemId || "")
          );

          return !liveMenuItem || !liveMenuItem.available;
        });

        if (hasUnavailableItem) {
          await conversationSessionRepo.clearSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId
          );
          const replyText = "One or more selected items are no longer available. Send HI to start again.";
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_item_no_longer_available",
            replyText,
          };
        }
      }

      const menuItem =
        menuItems.find((item) => String(item.id) === String(session.itemId || "")) || null;
      if (!sessionMatched.length && (!menuItem || !menuItem.available)) {
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

      const order =
        Array.isArray(session.matched) && session.matched.length
          ? await orderService.createGuidedOrderFromItems({
              restaurantId,
              customer,
              channel: normalized.channel,
              channelCustomerId: normalized.channelCustomerId,
              customerPhone: normalized.customerPhone,
              providerMessageId,
              matched: session.matched,
              fulfillmentType: String(session.fulfillmentType || "pickup"),
              deliveryAddress: String(session.deliveryAddress || "").trim(),
              rawMessage: normalized.text,
            })
          : await orderService.createGuidedOrder({
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

    const incomingMessage = normalized.text || "";
    const lower = normalizeText(incomingMessage);
    const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
    const isStaffAlertSender = isRestaurantStaffAlertSender(restaurant, normalized);
    const existingSession = await conversationSessionRepo.getSession(
      restaurantId,
      normalized.channel,
      normalized.channelCustomerId
    );

    if (
      isStaffAlertSender &&
      existingSession &&
      existingSession.state === FLOW_STATES.AWAITING_STAFF_ORDER_ACTION &&
      existingSession.orderId
    ) {
      const activeStaffOrder = await orderService.getOrder({
        restaurantId,
        orderId: existingSession.orderId,
      });

      if (activeStaffOrder.status !== ORDER_STATUSES.PENDING_CONFIRMATION) {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );

        const replyText = `Order #${activeStaffOrder.id} is already ${String(
          activeStaffOrder.status || "updated"
        ).replace(/_/g, " ")}.`;
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "staff_order_already_updated",
          replyText,
          orderId: activeStaffOrder.id,
        };
      }

      if (lower === "1" || lower === "confirm" || lower === "confirm order") {
        const updatedOrder = await orderService.confirmOrder({
          restaurantId,
          orderId: activeStaffOrder.id,
          actor: {
            type: "staff",
            id: normalized.channelCustomerId,
          },
        });

        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );

        const replyText = buildRestaurantOrderAlertHandledMessage(
          updatedOrder,
          "Customer has been updated."
        );
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "staff_confirmed_order",
          replyText,
          orderId: updatedOrder.id,
        };
      }

      if (lower === "2" || lower === "not available") {
        const updatedOrder = await orderService.rejectOrder({
          restaurantId,
          orderId: activeStaffOrder.id,
          actor: {
            type: "staff",
            id: normalized.channelCustomerId,
          },
          note: "One or more items are not available right now.",
        });

        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );

        const replyText = buildRestaurantOrderAlertHandledMessage(
          updatedOrder,
          "Customer has been notified."
        );
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "staff_rejected_order",
          replyText,
          orderId: updatedOrder.id,
        };
      }

      if (lower === "3" || lower === "contact customer") {
        const replyText = buildRestaurantContactCustomerMessage(activeStaffOrder);
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "staff_contact_customer",
          replyText,
          orderId: activeStaffOrder.id,
        };
      }

      {
        const replyText =
          "Reply with one option:\n1 - Confirm\n2 - Not Available\n3 - Contact Customer";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "staff_order_action_prompt",
          replyText,
          orderId: activeStaffOrder.id,
        };
      }
    }

    const customer = await customerService.upsertCustomerFromChannelMessage({
      restaurantId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
      customerPhone: normalized.customerPhone,
      displayName: normalized.displayName || "",
    });

    const activeOrder = await orderService.findActiveOrderByCustomer({
      restaurantId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
    });
    const hasBlockingActiveOrder =
      activeOrder && CUSTOMER_BLOCKING_ORDER_STATUSES.includes(activeOrder.status);
    const earlyMatchedResult = !hasBlockingActiveOrder
      ? await orderService.resolveRequestedItems({
          restaurantId,
          messageText: incomingMessage,
        })
      : { matched: [] };
    const seemsLikeStructuredOrder =
      !hasBlockingActiveOrder &&
      earlyMatchedResult.matched.length > 0 &&
      !looksLikeQuestion(lower, incomingMessage);

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

    if (existingSession) {
      if (
        existingSession.state === FLOW_STATES.AWAITING_PAYMENT_REFERENCE &&
        existingSession.orderId
      ) {
        const updatedOrder = await paymentService.appendCustomerPaymentReference({
          restaurantId,
          orderId: existingSession.orderId,
          note: incomingMessage,
          actorId: normalized.channelCustomerId,
          providerMessageId,
        });

        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );

        const replyText = buildPaymentReferenceSavedMessage();
        if (sendMessage) {
          await orderService.sendMessageToOrderCustomer(updatedOrder, replyText, {
            type: "payment_reference_saved",
            sourceAction: "customerPaymentReferenceSaved",
            sourceRef: updatedOrder.id,
            providerMessageId,
          });
        }

        return {
          handled: true,
          shouldReply: true,
          type: "payment_reference_saved",
          replyText,
          orderId: updatedOrder.id,
        };
      }

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

    if (isGreetingText(lower)) {
      const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
      const replyText = buildGreetingMessage(restaurant && restaurant.name);
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "greeting",
        replyText,
      };
    }

    if (isMenuOrStockQuestion(lower)) {
      const [menuItems, restaurant] = await Promise.all([
        menuService.listAvailableMenuItems(restaurantId),
        restaurantRepo.getRestaurantById(restaurantId),
      ]);
      const wantsStockOnly =
        lower.includes("stock") || lower.includes("available") || lower.includes("what do you have");

      if (wantsStockOnly) {
        const replyText = buildStockAvailabilityMessage(menuItems);
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "stock_info",
          replyText,
        };
      }

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

      return beginGuidedOrderingFlow({
        restaurantId,
        normalized,
        restaurant,
        menuItems,
        sendMessage,
      });
    }

    if (!hasBlockingActiveOrder && !looksLikeNewOrderAttempt(lower) && !seemsLikeStructuredOrder) {
      const [menuItems, restaurant] = await Promise.all([
        menuService.listAvailableMenuItems(restaurantId),
        restaurantRepo.getRestaurantById(restaurantId),
      ]);

      const llmResult = await maybeHandleWithLlm({
        restaurantId,
        normalized,
        restaurant,
        menuItems,
        sendMessage,
      });

      if (llmResult) {
        return llmResult;
      }

      if (looksLikeQuestion(lower, incomingMessage)) {
        const replyText = buildQuestionFallbackReply(lower, incomingMessage, menuItems);
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "question_fallback",
          replyText,
        };
      }
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

    if (
      activeOrder &&
      (activeOrder.status === ORDER_STATUSES.AWAITING_PAYMENT ||
        activeOrder.status === ORDER_STATUSES.PAYMENT_REVIEW) &&
      looksLikePaymentReported(lower)
    ) {
      if (activeOrder.status === ORDER_STATUSES.PAYMENT_REVIEW) {
        const replyText = buildPaymentStillUnderReviewMessage();
        if (sendMessage) {
          await orderService.sendMessageToOrderCustomer(activeOrder, replyText, {
            type: "payment_review_reminder",
            sourceAction: "customerPaymentReviewReminder",
            sourceRef: activeOrder.id,
            providerMessageId,
          });
        }

        return {
          handled: true,
          shouldReply: true,
          type: "payment_already_under_review",
          replyText,
          orderId: activeOrder.id,
        };
      }

      const updatedOrder = await paymentService.markCustomerPaymentReported({
        restaurantId,
        orderId: activeOrder.id,
        actorId: normalized.channelCustomerId,
        note: incomingMessage,
        providerMessageId,
      });

      const paymentReference = extractPaymentReferenceDetails(incomingMessage);
      if (paymentReference) {
        const orderWithReference = await paymentService.appendCustomerPaymentReference({
          restaurantId,
          orderId: updatedOrder.id,
          note: paymentReference,
          actorId: normalized.channelCustomerId,
          providerMessageId,
        });

        const replyText =
          "Thanks, I have noted your payment message and added your transfer details for the restaurant team. They will confirm your payment shortly.";
        if (sendMessage) {
          await orderService.sendMessageToOrderCustomer(orderWithReference, replyText, {
            type: "payment_review_acknowledged_with_reference",
            sourceAction: "customerPaymentReportedWithReference",
            sourceRef: orderWithReference.id,
            providerMessageId,
          });
        }

        return {
          handled: true,
          shouldReply: true,
          type: "payment_reported_with_reference",
          replyText,
          orderId: orderWithReference.id,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: FLOW_STATES.AWAITING_PAYMENT_REFERENCE,
          orderId: updatedOrder.id,
        }
      );

      const replyText = buildPaymentReviewAcknowledgedMessage();
      if (sendMessage) {
        await orderService.sendMessageToOrderCustomer(updatedOrder, replyText, {
          type: "payment_review_acknowledged",
          sourceAction: "customerPaymentReported",
          sourceRef: updatedOrder.id,
          providerMessageId,
        });
      }

      return {
        handled: true,
        shouldReply: true,
        type: "payment_reported",
        replyText,
        orderId: updatedOrder.id,
      };
    }

    if (
      activeOrder &&
      activeOrder.status === ORDER_STATUSES.PENDING_CONFIRMATION &&
      (looksLikeAddIntent(lower) || looksLikeRemoveIntent(lower) || looksLikeFulfillmentChange(lower))
    ) {
      const { matched: requestedMatched } = await orderService.resolveRequestedItems({
        restaurantId,
        messageText: incomingMessage,
      });

      let nextMatched = Array.isArray(activeOrder.matched) ? activeOrder.matched : [];
      if (looksLikeAddIntent(lower) && requestedMatched.length) {
        nextMatched = mergeMatchedItems(nextMatched, requestedMatched);
      } else if (looksLikeRemoveIntent(lower) && requestedMatched.length) {
        nextMatched = removeMatchedItems(nextMatched, requestedMatched);
      }

      if (!nextMatched.length) {
        const replyText =
          "Your pending order would become empty after that change. Reply CANCEL if you want to cancel it instead.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "pending_order_edit_empty",
          replyText,
        };
      }

      const inlineFulfillmentType = extractInlineFulfillmentType(incomingMessage);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(incomingMessage)
          : "";
      const nextFulfillmentType =
        inlineFulfillmentType || String(activeOrder.fulfillmentType || "").trim() || "";
      const nextAddress =
        nextFulfillmentType === "delivery"
          ? inlineAddress || String(activeOrder.deliveryAddress || "").trim()
          : "";

      if (nextFulfillmentType === "delivery" && !nextAddress) {
        const replyText =
          "Okay, I can switch this to delivery. Please send your delivery address first.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "pending_order_needs_address",
          replyText,
        };
      }

      const updatedOrder = await orderService.updatePendingOrderFromCustomer({
        restaurantId,
        orderId: activeOrder.id,
        matched: nextMatched,
        fulfillmentType: nextFulfillmentType || undefined,
        deliveryAddress: nextAddress,
        rawMessage: incomingMessage,
        providerMessageId,
        actor: {
          type: "customer",
          id: normalized.channelCustomerId,
        },
        reason: "customer_updated_pending_order",
      });

      const replyText = buildOrderUpdatedMessage({
        matched: updatedOrder.matched,
        total: updatedOrder.total,
        unavailable: updatedOrder.unavailable,
      });

      await orderService.sendMessageToOrderCustomer(updatedOrder, replyText, {
        type: "pending_order_updated",
        sourceAction: "customerPendingOrderUpdated",
        sourceRef: updatedOrder.id,
        providerMessageId,
      });

      return {
        handled: true,
        shouldReply: true,
        type: "pending_order_updated",
        replyText,
        orderId: updatedOrder.id,
      };
    }

    if (lower === "cancel") {
      if (hasBlockingActiveOrder) {
        const updatedOrder = await orderService.transitionOrderStatus({
          restaurantId,
          orderId: activeOrder.id,
          toStatus: ORDER_STATUSES.CANCELLED,
          actor: {
            type: "customer",
            id: normalized.channelCustomerId,
          },
          reason: "customer_cancelled_active_order",
        });

        const replyText = "Your current order has been cancelled. You can now place a new one.";
        if (sendMessage) {
          await orderService.sendMessageToOrderCustomer(updatedOrder, replyText, {
            type: "customer_cancelled_order",
            sourceAction: "customerCancelActiveOrder",
            sourceRef: updatedOrder.id,
            providerMessageId,
          });
        }

        return {
          handled: true,
          shouldReply: true,
          type: "cancel_active_order",
          replyText,
          orderId: updatedOrder.id,
        };
      }

      const replyText = buildNoPendingCancelMessage();
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "cancel_noop",
        replyText,
      };
    }

    if (
      hasBlockingActiveOrder &&
      looksLikeNewOrderAttempt(lower)
    ) {
      const replyText = buildActiveOrderExistsMessage(activeOrder);
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "active_order_exists",
        replyText,
        orderId: activeOrder.id,
      };
    }

    if (!hasBlockingActiveOrder && (looksLikeNewOrderAttempt(lower) || seemsLikeStructuredOrder)) {
      const menuItems = await menuService.listAvailableMenuItems(restaurantId);
      const selectedItem = resolveMenuSelection(menuItems, incomingMessage);
      const inlineQuantity = extractInlineQuantity(incomingMessage);
      const hasMultipleItems = mentionsMultipleMenuItems(menuItems, incomingMessage);
      const inlineFulfillmentType = extractInlineFulfillmentType(incomingMessage);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(incomingMessage)
          : "";
      const matched = earlyMatchedResult.matched;
      const cartTotal = calculateMatchedTotal(matched);

      if (matched.length > 1) {
        if (inlineFulfillmentType === "pickup") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_CONFIRMATION,
              matched,
              total: cartTotal,
              fulfillmentType: "pickup",
              deliveryAddress: "",
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            matched,
            total: cartTotal,
            fulfillmentType: "pickup",
            address: "",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery" && inlineAddress) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_CONFIRMATION,
              matched,
              total: cartTotal,
              fulfillmentType: "delivery",
              deliveryAddress: inlineAddress,
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            matched,
            total: cartTotal,
            fulfillmentType: "delivery",
            address: inlineAddress,
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: FLOW_STATES.AWAITING_ADDRESS,
              matched,
              total: cartTotal,
              fulfillmentType: "delivery",
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
            state: FLOW_STATES.AWAITING_FULFILLMENT_TYPE,
            matched,
            total: cartTotal,
          }
        );

        const replyText = buildDeliveryOrPickupPrompt({
          matched,
          total: cartTotal,
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "guided_multi_item_fulfillment_prompt",
          replyText,
        };
      }

      if (selectedItem && !inlineQuantity && !hasMultipleItems) {
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
      if (looksLikeQuestion(lower, incomingMessage)) {
        const menuItems = await menuService.listAvailableMenuItems(restaurantId);
        const replyText = buildQuestionFallbackReply(lower, incomingMessage, menuItems);

        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "question_fallback",
          replyText,
        };
      }

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
