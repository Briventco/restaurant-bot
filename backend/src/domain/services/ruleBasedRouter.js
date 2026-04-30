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
  async function tryHandleConversation({
    restaurantId,
    normalized,
    lower,
    incomingMessage,
    hasBlockingActiveOrder,
    seemsLikeStructuredOrder,
    sendMessage,
  }) {
    if (!hasBlockingActiveOrder && !looksLikeNewOrderAttempt(lower) && !seemsLikeStructuredOrder) {
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
            reason: "no_order_signal_and_no_llm_direct_answer",
          },
        };
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
        decision: {
          handler: "rule_greeting",
          intent: "greeting",
          confidence: 1,
          reason: "matched_greeting_rule",
        },
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
          decision: {
            handler: "rule_stock_info",
            intent: "stock_request",
            confidence: 1,
            reason: "matched_menu_stock_rule",
          },
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
          decision: {
            handler: "rule_menu_cooldown",
            intent: "menu_request",
            confidence: 1,
            reason: "menu_reply_throttled",
          },
        };
      }

      return chatOrchestrator.beginGuidedOrderingFlow({
        restaurantId,
        normalized,
        restaurant,
        menuItems,
        sendMessage,
      });
    }

    if (isAcknowledgementText(lower)) {
      const replyText = hasBlockingActiveOrder
        ? "You are welcome. Your order is still in progress. Reply CANCEL any time if you want to cancel it."
        : "You are welcome. I am here whenever you are ready. Reply MENU to see what is available.";
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "acknowledgement",
        replyText,
        decision: {
          handler: "rule_acknowledgement",
          intent: "acknowledgement",
          confidence: 1,
          reason: hasBlockingActiveOrder
            ? "matched_ack_rule_with_active_order"
            : "matched_ack_rule_no_active_order",
        },
      };
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
