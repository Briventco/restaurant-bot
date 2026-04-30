function toSafeEntities(entities) {
  const safe = entities && typeof entities === "object" ? entities : {};
  return {
    items: Array.isArray(safe.items)
      ? safe.items.map((v) => String(v || "").trim()).filter(Boolean)
      : [],
    quantity: Number.isFinite(Number(safe.quantity)) ? Number(safe.quantity) : 0,
    fulfillmentType: String(safe.fulfillmentType || "").trim().toLowerCase(),
    location: String(safe.location || "").trim(),
    budget: Number.isFinite(Number(safe.budget)) ? Number(safe.budget) : 0,
  };
}

function buildFallbackReply(intent) {
  if (intent === "delivery_question") {
    return "Please share your area and I will guide delivery options.";
  }
  if (intent === "recommendation") {
    return "Do you want a recommendation by budget or taste?";
  }
  if (intent === "menu_request") {
    return "Sure, I can show the menu and help you start your order.";
  }
  return "I can help with menu, ordering, delivery, and availability. What do you need now?";
}

function buildDraftFromDecision(decision) {
  const entities = toSafeEntities(decision.entities);
  const intent = String(decision.intent || "unknown").trim().toLowerCase() || "unknown";
  const confidence = Number.isFinite(Number(decision.confidence))
    ? Number(decision.confidence)
    : 0;

  let action = "ask_clarify";
  if (intent === "menu_request") {
    action = "start_guided";
  } else if (intent === "place_order" && entities.items.length) {
    action = "create_order_draft";
  } else if (decision.shouldHandleDirectly && confidence >= 0.45) {
    action = "reply_only";
  } else if (confidence < 0.45) {
    action = "ask_clarify";
  } else if (intent === "support") {
    action = "handoff";
  }

  const replyText = String(decision.replyText || "").trim() || buildFallbackReply(intent);

  return {
    intent,
    confidence,
    action,
    reply_text: replyText,
    entities,
    next_state_patch: {},
  };
}

function validateAiDecision(raw) {
  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["not_object"] };
  }

  const allowedActions = new Set([
    "reply_only",
    "start_guided",
    "create_order_draft",
    "ask_clarify",
    "handoff",
  ]);

  const errors = [];
  if (!raw.intent || typeof raw.intent !== "string") {
    errors.push("invalid_intent");
  }
  if (!Number.isFinite(Number(raw.confidence))) {
    errors.push("invalid_confidence");
  }
  if (!allowedActions.has(String(raw.action || ""))) {
    errors.push("invalid_action");
  }
  if (typeof raw.reply_text !== "string") {
    errors.push("invalid_reply_text");
  }
  if (!raw.entities || typeof raw.entities !== "object") {
    errors.push("invalid_entities");
  }
  if (!raw.next_state_patch || typeof raw.next_state_patch !== "object") {
    errors.push("invalid_next_state_patch");
  }

  return { valid: errors.length === 0, errors };
}

function createAiOrchestrator({ llmService }) {
  async function decideMessage({
    restaurant,
    menuItems,
    messageText,
    conversationContext = "",
  }) {
    if (!llmService) {
      return {
        valid: false,
        reason: "llm_unavailable",
        errors: ["llm_unavailable"],
      };
    }

    const decision = await llmService.classifyRestaurantMessage({
      restaurant,
      menuItems,
      messageText,
      conversationContext,
    });

    const draft = buildDraftFromDecision(decision);
    const validation = validateAiDecision(draft);

    return {
      valid: validation.valid,
      reason: validation.valid ? "ok" : "schema_invalid",
      errors: validation.errors,
      output: draft,
      source: {
        intent: String(decision.intent || "unknown"),
        confidence: Number(decision.confidence || 0),
      },
    };
  }

  return {
    decideMessage,
    validateAiDecision,
  };
}

module.exports = {
  createAiOrchestrator,
  validateAiDecision,
};
