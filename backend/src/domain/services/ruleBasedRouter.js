function createRuleBasedRouter({
  menuService,
  restaurantRepo,
  shouldThrottleMenuReply,
  chatOrchestrator,
  sendText,
  isGreetingText,
  isMenuOrStockQuestion,
  isAcknowledgementText,
  looksLikeNewOrderAttempt,
  looksLikeQuestion,
  buildGreetingMessage,
  buildStockAvailabilityMessage,
  buildQuestionFallbackReply,
}) {
  function buildConversationalFallbackReply(restaurantName) {
    return `I'm your ${restaurantName} assistant. I can help with menu, recommendations, delivery, and placing orders. What would you like to do?`;
  }

  async function tryHandleConversation({
    restaurantId,
    normalized,
    lower,
    incomingMessage,
    hasActiveOrder,
    hasBlockingActiveOrder,
    seemsLikeStructuredOrder,
    sendMessage,
  }) {
    // Let downstream explicit structured order or transactional logic handle these cases
    if (
      hasActiveOrder ||
      hasBlockingActiveOrder ||
      looksLikeNewOrderAttempt(lower) ||
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

    // Fallback if LLM times out or fails
    if (looksLikeQuestion(lower, incomingMessage)) {
      const replyText = buildQuestionFallbackReply(lower, incomingMessage, menuItems);
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "question_fallback",
        replyText,
        decision: {
          handler: "rule_question_fallback",
          intent: "question",
          confidence: 0.4,
          reason: "llm_fallback_question",
        },
      };
    }

    const replyText = buildConversationalFallbackReply(restaurant.name);
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
