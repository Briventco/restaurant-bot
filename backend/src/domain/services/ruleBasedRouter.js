function createRuleBasedRouter({
  menuService,
  restaurantRepo,
  shouldThrottleMenuReply,
  chatOrchestrator,
  sendText,
  llmDirectIntentThreshold = 0.45,
  buildQuestionFallbackReply,
}) {
  function buildConversationalFallbackReply(restaurantName) {
    return `I'm your ${restaurantName} assistant. I can help with menu, recommendations, delivery, and placing orders. What would you like to do?`;
  }

  async function tryHandleConversation({
    restaurantId,
    normalized,
    llmDecision,
    hasActiveOrder,
    hasBlockingActiveOrder,
    seemsLikeStructuredOrder,
    sendMessage,
  }) {
    const decision = llmDecision && typeof llmDecision === "object" ? llmDecision : {};
    const intent = String(decision.intent || "unknown").trim().toLowerCase();
    const confidence = Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : 0;

    // Use structured LLM intent for recommendation handling.
    if (intent === "recommendation" && confidence >= llmDirectIntentThreshold) {
      const menuItems = await menuService.listAvailableMenuItems(restaurantId);
      const availableItems = menuItems.filter((item) => item.available);
      const sorted = [...availableItems].sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
      const availableText = availableItems.map((item) => `${item.name} (N${item.price})`).join(", ");
      let replyText;
      if (!sorted.length) {
        replyText = "I don't have any available items listed right now.";
      } else {
        replyText = `I'd recommend ${sorted[0].name} at N${sorted[0].price}. We also have ${availableText}.`;
      }
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "recommendation_direct",
        replyText,
        decision: {
          handler: "rule_recommendation_direct",
          intent: "recommendation",
          confidence: confidence || 1,
          reason: "llm_intent_recommendation",
        },
      };
    }

    // Let downstream deterministic transaction flow handle high-risk intents.
    if (
      hasActiveOrder ||
      hasBlockingActiveOrder ||
      ["place_order", "add_item", "remove_item", "confirm", "cancel"].includes(intent) ||
      seemsLikeStructuredOrder
    ) {
      return null;
    }

    const [menuItems, restaurant] = await Promise.all([
      menuService.listAvailableMenuItems(restaurantId),
      restaurantRepo.getRestaurantById(restaurantId),
    ]);

    const llmResult = await chatOrchestrator.maybeHandleWithLlm({
      restaurantId,
      normalized,
      restaurant,
      menuItems,
      sendMessage,
    });

    if (llmResult && llmResult.handled !== false) {
      return llmResult;
    }

    // Fallback based on LLM "question-like" intents.
    if (
      ["question", "support", "delivery_question", "price_question", "availability_question", "stock_request"].includes(intent)
    ) {
      const fallbackLower = String(normalized && normalized.text ? normalized.text : "").toLowerCase();
      const replyText = buildQuestionFallbackReply(fallbackLower, normalized.text, menuItems);
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "question_fallback",
        replyText,
        decision: {
          handler: "rule_question_fallback",
          intent: "question",
          confidence: Math.max(0.35, confidence),
          reason: "llm_intent_question_fallback",
        },
      };
    }

    const replyText = buildConversationalFallbackReply(restaurant && restaurant.name ? restaurant.name : "");
    await sendText(sendMessage, normalized.channelCustomerId, replyText);
    return {
      handled: true,
      shouldReply: true,
      type: "conversation_fallback",
      replyText,
      decision: {
        handler: "rule_conversation_fallback",
        intent: "unknown",
        confidence: 0.35,
        reason: "llm_fallback_general",
      },
    };
  }

  return {
    tryHandleConversation,
  };
}

module.exports = {
  createRuleBasedRouter,
};
