function createRuleBasedRouter({
  menuService,
  restaurantRepo,
  shouldThrottleMenuReply,
  chatOrchestrator,
  sendText,
}) {
  async function tryHandleConversation({
    restaurantId,
    normalized,
    llmDecision,
    precomputedDecision,
    llmParserOnlyMode = false,
    hasActiveOrder,
    hasBlockingActiveOrder,
    seemsLikeStructuredOrder,
    sendMessage,
  }) {
    const decision = llmDecision && typeof llmDecision === "object" ? llmDecision : {};
    const intent = String(decision.intent || "unknown").trim().toLowerCase();

    // Defer transactional intents to downstream deterministic handlers
    if (
      hasActiveOrder ||
      hasBlockingActiveOrder ||
      ["place_order", "add_item", "remove_item", "confirm", "cancel"].includes(intent) ||
      seemsLikeStructuredOrder
    ) {
      return null;
    }

    if (!llmParserOnlyMode) {
      const [menuItems, restaurant] = await Promise.all([
        menuService.listAvailableMenuItems(restaurantId),
        restaurantRepo.getRestaurantById(restaurantId),
      ]);

      // Pass precomputedDecision so chatOrchestrator does not call the LLM a second time
      const llmResult = await chatOrchestrator.maybeHandleWithLlm({
        restaurantId,
        normalized,
        restaurant,
        menuItems,
        sendMessage,
        precomputedDecision: precomputedDecision || null,
      });

      if (llmResult && llmResult.handled !== false) {
        return llmResult;
      }
    }

    return null;
  }

  return {
    tryHandleConversation,
  };
}

module.exports = {
  createRuleBasedRouter,
};
