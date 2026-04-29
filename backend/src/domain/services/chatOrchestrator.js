const { buildMenuWelcome } = require("../templates/messages");

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

function getClarificationThreshold(intent) {
  return getDirectReplyThreshold(intent) * 0.8;
}

function buildClarificationReply(intent, menuItems) {
  const availableItems = (menuItems || [])
    .filter((item) => item.available)
    .map((item) => item.name)
    .filter(Boolean);
  const sample = availableItems.slice(0, 3).join(", ");

  if (intent === "delivery_question") {
    return "I can help with delivery. Please share your area so I can guide you properly.";
  }
  if (intent === "recommendation") {
    return sample
      ? `Sure. Do you want a recommendation by budget or taste? For example: ${sample}.`
      : "Sure. Do you want a recommendation by budget or taste?";
  }
  if (intent === "price_question" || intent === "availability_question" || intent === "stock_request") {
    return "Which item should I check for you?";
  }
  if (intent === "support") {
    return "I can help with menu, ordering, delivery, and payment flow. What do you need right now?";
  }

  return "I can help with menu, delivery, and ordering. Do you want to place an order now or check availability first?";
}

function normalizeEntities(entities) {
  const safe = entities && typeof entities === "object" ? entities : {};
  return {
    items: Array.isArray(safe.items) ? safe.items : [],
    quantity: Number.isFinite(Number(safe.quantity)) ? Number(safe.quantity) : 0,
    fulfillmentType: String(safe.fulfillmentType || "").trim().toLowerCase(),
    location: String(safe.location || "").trim(),
    budget: Number.isFinite(Number(safe.budget)) ? Number(safe.budget) : 0,
  };
}

function buildEntityOrderConfirmation(menuItems, entities) {
  const availableNames = new Set(
    (menuItems || [])
      .filter((item) => item.available)
      .map((item) => String(item.name || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const matchedItems = (entities.items || [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .filter((name) => availableNames.has(name.toLowerCase()));

  if (!matchedItems.length) {
    return "";
  }

  const quantity = entities.quantity > 0 ? entities.quantity : 1;
  const itemText =
    matchedItems.length === 1
      ? `${quantity} ${matchedItems[0]}`
      : matchedItems.map((name) => `${quantity} ${name}`).join(", ");

  if (entities.fulfillmentType === "delivery") {
    return `Great, I got ${itemText} for delivery. Should I continue with this order?`;
  }
  if (entities.fulfillmentType === "pickup") {
    return `Great, I got ${itemText} for pickup. Should I continue with this order?`;
  }

  return `Great, I got ${itemText}. Should this be delivery or pickup?`;
}

function createChatOrchestrator({
  llmService,
  conversationSessionRepo,
  flowStates,
  sendText,
  llmTimeoutMs = 1800,
}) {
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
        state: flowStates.AWAITING_ITEM,
        restaurantName: String((restaurant && restaurant.name) || "").trim(),
      }
    );

    await sendText(sendMessage, normalized.channelCustomerId, replyText);

    return {
      handled: true,
      shouldReply: true,
      type: "guided_menu",
      replyText,
      decision: {
        handler: "guided_flow_start",
        intent: "menu_request",
        confidence: 1,
        reason: "guided_ordering_requested",
      },
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

    const llmStartedAt = Date.now();
    let decision;
    try {
      decision = await Promise.race([
        llmService.classifyRestaurantMessage({
          restaurant,
          menuItems,
          messageText: normalized.text,
          conversationContext: String(normalized.conversationContext || ""),
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("llm_timeout")), llmTimeoutMs)
        ),
      ]);
    } catch (_error) {
      return {
        handled: false,
        shouldReply: false,
        type: "llm_timeout_fallback",
        decision: {
          handler: "llm_timeout_fallback",
          intent: "unknown",
          confidence: 0,
          reason: "llm_timeout",
          metrics: {
            llm_ms: Date.now() - llmStartedAt,
          },
        },
      };
    }
    const entities = normalizeEntities(decision.entities);
    const llmMs = Date.now() - llmStartedAt;

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

    if (decision.intent === "place_order") {
      const confirmationText = buildEntityOrderConfirmation(menuItems, entities);
      if (confirmationText) {
        await sendText(sendMessage, normalized.channelCustomerId, confirmationText);
        return {
          handled: true,
          shouldReply: true,
          type: "llm_order_entity_confirmation",
          replyText: confirmationText,
          decision: {
            handler: "llm_order_entity_confirmation",
            intent: "place_order",
            confidence: Number(decision.confidence || 0),
            reason: "llm_detected_partial_order_entities",
            entities,
          },
        };
      }
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
        decision: {
          handler: "llm_direct",
          intent: String(decision.intent || "unknown"),
          confidence: Number(decision.confidence || 0),
          reason: "llm_confident_direct_reply",
          entities,
          metrics: {
            llm_ms: llmMs,
          },
        },
      };
    }

    if (
      decision.confidence >= getClarificationThreshold(decision.intent) &&
      [
        "delivery_question",
        "support",
        "unknown",
        "stock_request",
        "availability_question",
        "recommendation",
        "price_question",
      ].includes(decision.intent)
    ) {
      let replyText = buildClarificationReply(decision.intent, menuItems);
      if (entities.budget > 0 && decision.intent === "recommendation") {
        replyText = `Sure. Should I suggest options under N${entities.budget}?`;
      }
      if (entities.location && decision.intent === "delivery_question") {
        replyText = `Thanks. For delivery to ${entities.location}, do you want to order now or check available items first?`;
      }
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: `llm_clarify_${decision.intent}`,
        replyText,
        decision: {
          handler: "llm_clarification",
          intent: String(decision.intent || "unknown"),
          confidence: Number(decision.confidence || 0),
          reason: "llm_medium_confidence_needs_clarification",
          entities,
          metrics: {
            llm_ms: llmMs,
          },
        },
      };
    }

    return null;
  }

  return {
    beginGuidedOrderingFlow,
    maybeHandleWithLlm,
  };
}

module.exports = {
  createChatOrchestrator,
};
