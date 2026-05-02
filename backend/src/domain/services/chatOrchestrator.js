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

function buildAssistantFallbackReply(menuItems) {
  const available = (menuItems || [])
    .filter((item) => item.available)
    .map((item) => `${item.name} (N${item.price})`);
  if (available.length) {
    return `I’m here to help. We currently have ${available.join(", ")}. Do you want to order now, ask about delivery, or get a recommendation?`;
  }
  return "I’m here to help with menu, delivery, and ordering. Tell me what you’d like.";
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

function buildEntityOrderConfirmation(matchedItems, fulfillmentType) {
  if (!Array.isArray(matchedItems) || !matchedItems.length) {
    return "";
  }

  const itemText = matchedItems
    .map((item) => `${Number(item.quantity || 0)}x ${item.name}`)
    .join(", ");

  if (fulfillmentType === "delivery") {
    return `Great, I got ${itemText} for delivery. Should I continue with this order?`;
  }
  if (fulfillmentType === "pickup") {
    return `Great, I got ${itemText} for pickup. Should I continue with this order?`;
  }

  return `Great, I got ${itemText}. Should this be delivery or pickup?`;
}

function matchLlmEntitiesToMenu(menuItems, entities) {
  const available = (menuItems || []).filter((item) => item.available);
  const matched = [];
  for (const entityName of entities.items || []) {
    const lower = String(entityName || "").trim().toLowerCase();
    if (!lower) continue;
    const found =
      available.find((item) => String(item.name || "").trim().toLowerCase() === lower) ||
      available.find((item) => String(item.name || "").trim().toLowerCase().includes(lower)) ||
      available.find((item) => lower.includes(String(item.name || "").trim().toLowerCase()));
    if (found) {
      matched.push({
        menuItemId: found.id,
        name: found.name,
        price: Number(found.price || 0),
        quantity: 1,
        subtotal: Number(found.price || 0),
      });
    }
  }
  return matched;
}

function createChatOrchestrator({
  llmService,
  resolveRequestedItems,
  conversationSessionRepo,
  flowStates,
  sendText,
  llmTimeoutMs = 15000,
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

  async function beginGuidedOrderingFlowWithItems({
    restaurantId,
    normalized,
    restaurant,
    menuItems,
    sendMessage,
    matched,
    fulfillmentType,
  }) {
    const total = matched.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
    const itemSummary = matched.map((i) => `${i.quantity}x ${i.name}`).join(", ");

    if (fulfillmentType === "pickup") {
      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        { state: flowStates.AWAITING_CONFIRMATION, matched, total, fulfillmentType: "pickup", deliveryAddress: "" }
      );
      const replyText = `Got it! ${itemSummary} for pickup. Total: N${total}.\n\nReply YES to confirm or NO to cancel.`;
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true, shouldReply: true, type: "guided_preseed_confirmation", replyText,
        decision: { handler: "guided_flow_preseed", intent: "place_order", confidence: 1, reason: "llm_entities_preseeded_pickup" },
      };
    }

    if (fulfillmentType === "delivery") {
      // LLM knows it's delivery but we still need the address — go to AWAITING_ADDRESS
      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        { state: flowStates.AWAITING_ADDRESS, matched, total, fulfillmentType: "delivery" }
      );
      const replyText = `Great, I got ${itemSummary} for delivery (Total: N${total}).\n\nPlease share your delivery address.`;
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true, shouldReply: true, type: "guided_preseed_address", replyText,
        decision: { handler: "guided_flow_preseed", intent: "place_order", confidence: 1, reason: "llm_entities_preseeded_delivery" },
      };
    }

    // No fulfillment type extracted — ask for it
    await conversationSessionRepo.upsertSession(
      restaurantId,
      normalized.channel,
      normalized.channelCustomerId,
      { state: flowStates.AWAITING_FULFILLMENT_TYPE, matched, total }
    );
    const replyText = `Great, I got ${itemSummary} (Total: N${total}).\n\nDelivery or pickup? Reply D for Delivery or P for Pickup.`;
    await sendText(sendMessage, normalized.channelCustomerId, replyText);
    return {
      handled: true, shouldReply: true, type: "guided_preseed_fulfillment", replyText,
      decision: { handler: "guided_flow_preseed", intent: "place_order", confidence: 1, reason: "llm_entities_preseeded" },
    };
  }

  async function maybeHandleWithLlm({
    restaurantId,
    normalized,
    restaurant,
    menuItems,
    sendMessage,
    allowGuidedFlow = true,
    activeOrder = null,
    sessionState = null,
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
          activeOrder,
          sessionState,
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
    let parsedMatchedLoaded = false;
    let parsedMatchedCache = [];
    const transactionalIntents = new Set([
      "place_order",
      "add_item",
      "remove_item",
      "confirm",
      "cancel",
    ]);

    async function getParsedMatchedItems() {
      if (parsedMatchedLoaded) {
        return parsedMatchedCache;
      }

      parsedMatchedLoaded = true;

      if (typeof resolveRequestedItems !== "function") {
        parsedMatchedCache = [];
        return parsedMatchedCache;
      }

      try {
        const resolved = await resolveRequestedItems({
          restaurantId,
          messageText: normalized.text,
        });
        parsedMatchedCache =
          resolved && Array.isArray(resolved.matched) ? resolved.matched : [];
      } catch (_error) {
        parsedMatchedCache = [];
      }

      return parsedMatchedCache;
    }

    // Handle suggestedAction from LLM (AI-first approach)
    if (decision.suggestedAction) {
      switch (decision.suggestedAction) {
        case "show_menu":
        case "start_guided_flow":
          if (allowGuidedFlow) {
            return beginGuidedOrderingFlow({
              restaurantId,
              normalized,
              restaurant,
              menuItems,
              sendMessage,
            });
          }
          break;
        case "answer_question":
          if (decision.replyText) {
            await sendText(sendMessage, normalized.channelCustomerId, decision.replyText);
            return {
              handled: true,
              shouldReply: true,
              type: "llm_answer_question",
              replyText: decision.replyText,
              decision: {
                handler: "llm_answer_question",
                intent: decision.intent,
                confidence: decision.confidence,
                reason: "llm_suggested_answer",
                entities,
                metrics: { llm_ms: llmMs },
              },
            };
          }
          break;
        case "handle_greeting":
          if (decision.replyText) {
            await sendText(sendMessage, normalized.channelCustomerId, decision.replyText);
            return {
              handled: true,
              shouldReply: true,
              type: "llm_greeting",
              replyText: decision.replyText,
              decision: {
                handler: "llm_greeting",
                intent: decision.intent,
                confidence: decision.confidence,
                reason: "llm_suggested_greeting",
                entities,
                metrics: { llm_ms: llmMs },
              },
            };
          }
          break;
        case "create_order":
        case "update_order": {
          if (allowGuidedFlow) {
            // Parse the raw message for item-level quantities so pricing always comes from each item.quantity.
            let prematched = await getParsedMatchedItems();
            if (!prematched.length) {
              prematched = matchLlmEntitiesToMenu(menuItems, entities);
            }
            if (prematched.length > 0) {
              return beginGuidedOrderingFlowWithItems({
                restaurantId,
                normalized,
                restaurant,
                menuItems,
                sendMessage,
                matched: prematched,
                fulfillmentType: entities.fulfillmentType || "",
              });
            }
            return beginGuidedOrderingFlow({
              restaurantId,
              normalized,
              restaurant,
              menuItems,
              sendMessage,
            });
          }
          break;
        }
      }
    }

    // Legacy fallback: handle based on intent if suggestedAction not provided
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
      let prematched = await getParsedMatchedItems();
      if (!prematched.length) {
        prematched = matchLlmEntitiesToMenu(menuItems, entities);
      }

      if (allowGuidedFlow && prematched.length) {
        return beginGuidedOrderingFlowWithItems({
          restaurantId,
          normalized,
          restaurant,
          menuItems,
          sendMessage,
          matched: prematched,
          fulfillmentType: entities.fulfillmentType || "",
        });
      }

      const confirmationText = buildEntityOrderConfirmation(prematched, entities.fulfillmentType);
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

      if (allowGuidedFlow && decision.confidence >= 0.35) {
        return beginGuidedOrderingFlow({
          restaurantId,
          normalized,
          restaurant,
          menuItems,
          sendMessage,
        });
      }
    }

    if (transactionalIntents.has(String(decision.intent || "").trim().toLowerCase())) {
      return {
        handled: false,
        shouldReply: false,
        type: "llm_transactional_intent_deferred",
        decision: {
          handler: "llm_transactional_intent_deferred",
          intent: String(decision.intent || "unknown"),
          confidence: Number(decision.confidence || 0),
          reason: "transactional_intents_require_deterministic_flow",
          entities,
          metrics: {
            llm_ms: llmMs,
          },
        },
      };
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

    const fallbackReply =
      decision.replyText ||
      buildClarificationReply(decision.intent, menuItems) ||
      buildAssistantFallbackReply(menuItems);
    await sendText(sendMessage, normalized.channelCustomerId, fallbackReply);
    return {
      handled: true,
      shouldReply: true,
      type: `llm_fallback_${decision.intent || "unknown"}`,
      replyText: fallbackReply,
      decision: {
        handler: "llm_fallback",
        intent: String(decision.intent || "unknown"),
        confidence: Number(decision.confidence || 0),
        reason: "llm_primary_non_transactional_fallback",
        entities,
        metrics: {
          llm_ms: llmMs,
        },
      },
    };
  }

  return {
    beginGuidedOrderingFlow,
    maybeHandleWithLlm,
  };
}

module.exports = {
  createChatOrchestrator,
};
