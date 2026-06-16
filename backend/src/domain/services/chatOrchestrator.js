const { buildMenuWelcome, buildUnknownReply } = require("../templates/messages");

function isMeaningfulText(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.length <= 2) {
    return false;
  }
  const trivial = new Set([
    "hi",
    "hey",
    "hello",
    "yo",
    "ok",
    "okay",
    "kk",
    "thanks",
    "thank you",
    "nice",
    "great",
  ]);
  return !trivial.has(normalized);
}

function updateSessionMemory({ previousTurns, previousSummary, userText, assistantText }) {
  const turns = Array.isArray(previousTurns)
    ? previousTurns.filter((item) => item && typeof item === "object")
    : [];
  const nextUser = String(userText || "").trim();
  const nextAssistant = String(assistantText || "").trim();
  const nextTurns = [...turns];

  if (isMeaningfulText(nextUser) && isMeaningfulText(nextAssistant)) {
    nextTurns.push({ user: nextUser, assistant: nextAssistant });
  }

  const compressedTurns = nextTurns.slice(-4);
  const fromTurns = compressedTurns
    .map((turn) => `User: ${String(turn.user || "").trim()} | Assistant: ${String(turn.assistant || "").trim()}`)
    .join(" || ");
  const summary = String(fromTurns || previousSummary || "").slice(-600);

  return {
    turns: compressedTurns,
    summary,
  };
}

function normalizeEntities(entities) {
  const safe = entities && typeof entities === "object" ? entities : {};
  return {
    items: Array.isArray(safe.items)
      ? safe.items
          .filter((item) => item && typeof item === "object" && item.name)
          .map((item) => ({
            name: String(item.name || "").trim(),
            quantity: Math.max(1, Math.round(Number(item.quantity || 1))),
          }))
          .filter((item) => item.name)
      : [],
    fulfillmentType: String(safe.fulfillmentType || "").trim().toLowerCase(),
    location: String(safe.location || "").trim(),
  };
}

function matchLlmEntitiesToMenu(menuItems, entities) {
  const available = (menuItems || []).filter((item) => item.available);
  return (entities.items || []).reduce((acc, entityItem) => {
    const lower = String(entityItem.name || "").trim().toLowerCase();
    if (!lower) return acc;
    const found =
      available.find((item) => String(item.name || "").trim().toLowerCase() === lower) ||
      available.find((item) => String(item.name || "").trim().toLowerCase().includes(lower)) ||
      available.find((item) => lower.includes(String(item.name || "").trim().toLowerCase()));
    if (found) {
      const qty = Math.max(1, Math.round(Number(entityItem.quantity || 1)));
      acc.push({
        menuItemId: found.id,
        name: found.name,
        price: Number(found.price || 0),
        quantity: qty,
        subtotal: Number(found.price || 0) * qty,
      });
    }
    return acc;
  }, []);
}

function createChatOrchestrator({
  llmService,
  resolveRequestedItems,
  conversationSessionRepo,
  flowStates,
  sendText,
  llmTimeoutMs = 15000,
  logger = null,
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

    // No fulfillment type — ask for it
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
    precomputedDecision = null,
  }) {
    if (!llmService) {
      return null;
    }

    const llmStartedAt = Date.now();
    let decision = precomputedDecision;
    if (!decision) {
      try {
        decision = await Promise.race([
          llmService.classifyRestaurantMessage({
            restaurant,
            menuItems,
            messageText: normalized.text,
            conversationContext: String(normalized.conversationContext || ""),
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
            metrics: { llm_ms: Date.now() - llmStartedAt },
          },
        };
      }
    }

    const entities = normalizeEntities(decision.entities);
    const intent = String(decision.intent || "unknown").trim().toLowerCase();
    const llmMs = Date.now() - llmStartedAt;

    if (logger && typeof logger.info === "function") {
      logger.info("[LLM_EXTRACT]", {
        session: `${restaurantId}:${normalized.channel}:${normalized.channelCustomerId}`,
        intent,
        confidence: decision.confidence,
        itemCount: entities.items.length,
        fulfillmentType: entities.fulfillmentType,
      });
    }

    async function persistLlmMemory(lastReplyText) {
      if (!conversationSessionRepo) return;
      const memory = updateSessionMemory({
        previousTurns: sessionState && sessionState.llmMemoryTurns,
        previousSummary: sessionState && sessionState.conversationSummary,
        userText: normalized.text,
        assistantText: lastReplyText,
      });
      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          llmLastIntent: intent,
          llmLastConfidence: Number(decision.confidence || 0),
          llmLastEntities: {
            items: entities.items.map((i) => i.name),
            fulfillmentType: entities.fulfillmentType,
            location: entities.location,
          },
          llmMemoryTurns: memory.turns,
          conversationSummary: memory.summary,
        }
      );
    }

    async function getParsedMatchedItems() {
      if (typeof resolveRequestedItems !== "function") return [];
      try {
        const resolved = await resolveRequestedItems({ restaurantId, messageText: normalized.text });
        return resolved && Array.isArray(resolved.matched) ? resolved.matched : [];
      } catch (_error) {
        return [];
      }
    }

    // Transactional intents — defer to deterministic downstream handlers
    if (["confirm", "cancel", "remove_item"].includes(intent)) {
      return {
        handled: false,
        shouldReply: false,
        type: "llm_transactional_intent_deferred",
        decision: {
          handler: "llm_transactional_intent_deferred",
          intent,
          confidence: Number(decision.confidence || 0),
          reason: "transactional_intents_require_deterministic_flow",
          entities,
          metrics: { llm_ms: llmMs },
        },
      };
    }

    // Menu request → guided flow
    if (intent === "menu_request" && allowGuidedFlow) {
      return beginGuidedOrderingFlow({ restaurantId, normalized, restaurant, menuItems, sendMessage });
    }

    // Order intent → match items, then guided flow
    if ((intent === "place_order" || intent === "add_item") && allowGuidedFlow) {
      let matched = matchLlmEntitiesToMenu(menuItems, entities);
      if (!matched.length) {
        matched = await getParsedMatchedItems();
      }
      if (matched.length > 0) {
        return beginGuidedOrderingFlowWithItems({
          restaurantId,
          normalized,
          restaurant,
          menuItems,
          sendMessage,
          matched,
          fulfillmentType: entities.fulfillmentType || "",
        });
      }
      return beginGuidedOrderingFlow({ restaurantId, normalized, restaurant, menuItems, sendMessage });
    }

    // Greeting is handled deterministically before LLM; if it somehow arrives here, pass through
    if (intent === "greeting") {
      return null;
    }

    // Unknown / anything else → pre-written template, never LLM text
    const replyText = buildUnknownReply();
    await sendText(sendMessage, normalized.channelCustomerId, replyText);
    await persistLlmMemory(replyText);
    return {
      handled: true,
      shouldReply: true,
      type: "llm_unknown",
      replyText,
      decision: {
        handler: "llm_unknown_template",
        intent,
        confidence: Number(decision.confidence || 0),
        reason: "extraction_only_unknown_fallback",
        entities,
        metrics: { llm_ms: llmMs },
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
