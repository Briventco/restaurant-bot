const { normalizeText } = require("../utils/text");
const { ORDER_STATUSES } = require("../constants/orderStatuses");
const {
  buildMenuWelcome,
  buildGreetingMessage,
  buildStockAvailabilityMessage,
  buildInvalidOrderMessage,
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
const { createChatOrchestrator } = require("./chatOrchestrator");
const { createRuleBasedRouter } = require("./ruleBasedRouter");
const { createGuidedSessionRouter } = require("./guidedSessionRouter");
const { createAiOrchestrator } = require("./aiOrchestrator");

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
    isFromMe: Boolean(input.isFromMe),
    isStatus: Boolean(input.isStatus),
    isBroadcast: Boolean(input.isBroadcast),
  };
}

function shouldIgnoreSystemInbound(normalized) {
  const channelCustomerId = String(normalized && normalized.channelCustomerId ? normalized.channelCustomerId : "")
    .trim()
    .toLowerCase();

  if (normalized && normalized.isFromMe) {
    return "from_me";
  }

  if ((normalized && normalized.isStatus) || channelCustomerId === "status@broadcast") {
    return "status_broadcast";
  }

  if (
    (normalized && normalized.isBroadcast) ||
    (channelCustomerId.endsWith("@broadcast") && channelCustomerId !== "status@broadcast")
  ) {
    return "broadcast";
  }

  return "";
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

function isAcknowledgementText(lower) {
  return (
    lower === "thanks" ||
    lower === "thank you" ||
    lower === "thank u" ||
    lower === "ok" ||
    lower === "okay" ||
    lower === "okk" ||
    lower === "alright" ||
    lower === "all right" ||
    lower === "alr" ||
    lower === "sure" ||
    lower === "nice" ||
    lower === "great" ||
    lower === "good"
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
    lower.startsWith("who") ||
    lower.startsWith("why") ||
    lower.startsWith("when") ||
    lower.startsWith("which") ||
    lower.startsWith("how") ||
    lower.startsWith("ehn") ||
    lower === "ehn" ||
    lower === "omor" ||
    lower.includes("what's up") ||
    lower.includes("wassup") ||
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
  const hasAvailableItems = availableItems.length > 0;

  if (
    lower.includes("deliver") ||
    lower.includes("delivery fee") ||
    lower.includes("how long") ||
    lower.includes("arrival time")
  ) {
    return hasAvailableItems
      ? `Yes, we support delivery. Share your location and I'll guide your order from ${availableText}.`
      : "Yes, we support delivery. Share your location and I will guide your order.";
  }

  if (
    lower.includes("pay") ||
    lower.includes("payment") ||
    lower.includes("transfer") ||
    lower.includes("account number")
  ) {
    return "Once your order is confirmed, we will share the payment steps and reference details. You can start by telling me what you want to order.";
  }

  if (
    lower.includes("human") ||
    lower.includes("agent") ||
    lower.includes("staff") ||
    lower.includes("call")
  ) {
    return "I can help quickly with menu, availability, delivery, and ordering. If you prefer staff support, say CONTACT STAFF and I will guide the next step.";
  }

  if (lower.startsWith("do you have")) {
    return hasAvailableItems
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

  if (hasAvailableItems) {
    return `I can help with menu, delivery, or placing an order. Right now we have ${availableText}. Do you want to order now or ask about delivery first?`;
  }

  return "I can help with menu, ordering, delivery, and item availability. Do you want to place an order now?";
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
  aiShadowMode = false,
  aiShadowTimeoutMs = 700,
}) {
  const menuCooldownByChat = new Map();
  const recentConversationByChat = new Map();
  const menuCacheByRestaurant = new Map();
  const effectiveMenuCooldownMs =
    Number(menuCooldownMs) > 0 ? Number(menuCooldownMs) : 90 * 1000;
  const maxRecentTurns = 6;
  const menuCacheTtlMs = 30 * 1000;

  function buildChatKey({ restaurantId, channel, channelCustomerId }) {
    return `${restaurantId}:${channel}:${channelCustomerId}`;
  }

  function getRecentConversationContext({ restaurantId, normalized }) {
    const key = buildChatKey({
      restaurantId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
    });
    const turns = recentConversationByChat.get(key) || [];
    return turns.length ? turns.map((item) => `${item.role}: ${item.text}`).join(" | ") : "";
  }

  function appendConversationTurn({ restaurantId, normalized, role, text }) {
    const value = String(text || "").trim();
    if (!value) {
      return;
    }
    const key = buildChatKey({
      restaurantId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
    });
    const existing = recentConversationByChat.get(key) || [];
    const next = [...existing, { role, text: value }].slice(-maxRecentTurns);
    recentConversationByChat.set(key, next);
  }

  function inferDecisionFromResult(result) {
    const type = String((result && result.type) || "unknown");
    const byType = {
      duplicate: { handler: "dedupe_guard", intent: "system", confidence: 1, reason: "duplicate_inbound_event" },
      empty_message: { handler: "empty_message_guard", intent: "unknown", confidence: 1, reason: "empty_message" },
      status_broadcast: { handler: "system_message_filter", intent: "system", confidence: 1, reason: "status_broadcast_ignored" },
      broadcast: { handler: "system_message_filter", intent: "system", confidence: 1, reason: "broadcast_ignored" },
      from_me: { handler: "system_message_filter", intent: "system", confidence: 1, reason: "from_me_ignored" },
      cancel_active_order: { handler: "active_order_cancel", intent: "cancel_order", confidence: 1, reason: "explicit_cancel_command" },
      cancel_noop: { handler: "active_order_cancel", intent: "cancel_order", confidence: 1, reason: "cancel_without_active_order" },
      order_created: { handler: "order_creation", intent: "place_order", confidence: 1, reason: "order_created_from_inbound" },
      invalid_order: { handler: "invalid_order_fallback", intent: "unknown", confidence: 0.3, reason: "order_parse_failed" },
      invalid_order_cooldown: { handler: "invalid_order_fallback", intent: "unknown", confidence: 0.3, reason: "invalid_order_reply_throttled" },
      question_fallback: { handler: "rule_question_fallback", intent: "question", confidence: 0.4, reason: "question_without_clear_intent" },
      payment_reported: { handler: "payment_flow", intent: "payment_reported", confidence: 1, reason: "payment_state_transition" },
      payment_reported_with_reference: { handler: "payment_flow", intent: "payment_reported", confidence: 1, reason: "payment_reference_captured_inline" },
      payment_reference_saved: { handler: "payment_flow", intent: "payment_reference", confidence: 1, reason: "payment_reference_saved" },
    };
    return byType[type] || { handler: type, intent: "unknown", confidence: 0.5, reason: `inferred_from_type:${type}` };
  }

  function withDecisionAndLog(restaurantId, normalized, result) {
    if (!result) {
      return result;
    }
    const withDecision = {
      ...result,
      decision:
        result.decision && typeof result.decision === "object"
          ? result.decision
          : inferDecisionFromResult(result),
    };

    const metrics = normalized._metrics || {};
    if (!metrics.total_ms && normalized._startedAt) {
      metrics.total_ms = Date.now() - normalized._startedAt;
      normalized._metrics = metrics;
    }
    logger.info("Inbound decision", {
      restaurantId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
      providerMessageId: buildProviderMessageId(normalized),
      type: withDecision.type,
      shouldReply: withDecision.shouldReply,
      decision: withDecision.decision,
      perf: {
        total_ms: Number(metrics.total_ms || 0),
        db_ms: Number(metrics.db_ms || 0),
        router_ms: Number(metrics.router_ms || 0),
        db_breakdown:
          metrics.db_breakdown && typeof metrics.db_breakdown === "object"
            ? metrics.db_breakdown
            : {},
      },
    });
    if (normalized._shadowDecision) {
      logger.info("Inbound AI shadow compare", {
        restaurantId,
        channel: normalized.channel,
        channelCustomerId: normalized.channelCustomerId,
        providerMessageId: buildProviderMessageId(normalized),
        live: {
          type: withDecision.type,
          handler:
            withDecision.decision && withDecision.decision.handler
              ? withDecision.decision.handler
              : "unknown",
          intent:
            withDecision.decision && withDecision.decision.intent
              ? withDecision.decision.intent
              : "unknown",
        },
        shadow: normalized._shadowDecision,
      });
    }

    appendConversationTurn({
      restaurantId,
      normalized,
      role: "user",
      text: normalized.text,
    });
    appendConversationTurn({
      restaurantId,
      normalized,
      role: "assistant",
      text: withDecision.replyText,
    });

    return withDecision;
  }

  async function listAvailableMenuItemsCached(restaurantId) {
    const now = Date.now();
    const existing = menuCacheByRestaurant.get(restaurantId);
    if (existing && existing.expiresAt > now) {
      return existing.items;
    }
    const items = await menuService.listAvailableMenuItems(restaurantId);
    menuCacheByRestaurant.set(restaurantId, {
      items,
      expiresAt: now + menuCacheTtlMs,
    });
    return items;
  }

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

  const chatOrchestrator = createChatOrchestrator({
    llmService,
    conversationSessionRepo,
    flowStates: FLOW_STATES,
    sendText,
    llmTimeoutMs: 8000,
  });
  const aiOrchestrator = createAiOrchestrator({
    llmService,
  });
  const menuServiceWithCache = {
    ...menuService,
    listAvailableMenuItems: listAvailableMenuItemsCached,
  };
  const ruleBasedRouter = createRuleBasedRouter({
    menuService: menuServiceWithCache,
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
  });
  const guidedSessionRouter = createGuidedSessionRouter({
    normalizeText,
    menuService: menuServiceWithCache,
    conversationSessionRepo,
    orderService,
    restaurantRepo,
    chatOrchestrator,
    flowStates: FLOW_STATES,
    sendText,
    resolveMenuSelection,
    looksLikeQuestion,
    extractInlineFulfillmentType,
    extractInlineAddress,
    calculateMatchedTotal,
    buildGuidedConfirmPrompt,
    buildAddressPrompt,
    buildDeliveryOrPickupPrompt,
    buildMenuWelcome,
    extractInlineQuantity,
    buildSelectedItemPrompt,
    toPositiveInteger,
    buildMatchedFromSession,
    looksLikeAddIntent,
    looksLikeRemoveIntent,
    looksLikeFulfillmentChange,
    mergeMatchedItems,
    removeMatchedItems,
    buildGuidedOrderConfirmedMessage,
  });

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

  async function handleGuidedSession(params) {
    return guidedSessionRouter.handleGuidedSession(params);
  }

  async function processInbound({ restaurantId, normalized, sendMessage }) {
    const startedAt = Date.now();
    normalized._startedAt = startedAt;
    normalized._metrics =
      normalized._metrics || { total_ms: 0, db_ms: 0, router_ms: 0, db_breakdown: {} };
    async function timed(metricKey, fn, stepName = "") {
      const t0 = Date.now();
      const out = await fn();
      const elapsed = Date.now() - t0;
      normalized._metrics[metricKey] =
        Number(normalized._metrics[metricKey] || 0) + elapsed;
      if (metricKey === "db_ms" && stepName) {
        const current = normalized._metrics.db_breakdown || {};
        current[stepName] = Number(current[stepName] || 0) + elapsed;
        normalized._metrics.db_breakdown = current;
      }
      return out;
    }
    async function timedDb(stepName, fn) {
      return timed("db_ms", fn, stepName);
    }
    async function timedRouter(fn) {
      return timed("router_ms", fn);
    }
    normalized.conversationContext = getRecentConversationContext({ restaurantId, normalized });
    const providerMessageId = buildProviderMessageId(normalized);

    const isNew = await timedDb("markInboundEventIfNew", () => inboundEventRepo.markInboundEventIfNew({
      restaurantId,
      providerMessageId,
      channel: normalized.channel,
      channelCustomerId: normalized.channelCustomerId,
      customerPhone: normalized.customerPhone,
    }));

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
    const [restaurant, existingSession] = await Promise.all([
      timedDb("getRestaurantById", () => restaurantRepo.getRestaurantById(restaurantId)),
      timedDb("getSession", () =>
        conversationSessionRepo.getSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        )
      ),
    ]);

    if (aiShadowMode && incomingMessage.trim()) {
      const shadowMeta = {
        restaurantId,
        channel: normalized.channel,
        channelCustomerId: normalized.channelCustomerId,
        providerMessageId,
      };
      (async () => {
        const shadowStartedAt = Date.now();
        try {
          const shadowResult = await Promise.race([
            aiOrchestrator.decideMessage({
              restaurant,
              menuItems: [],
              messageText: incomingMessage,
              conversationContext: String(normalized.conversationContext || ""),
            }),
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    valid: false,
                    reason: "shadow_timeout",
                    errors: ["shadow_timeout"],
                  }),
                aiShadowTimeoutMs
              )
            ),
          ]);
          logger.info("Inbound AI shadow result", {
            ...shadowMeta,
            shadow: shadowResult,
            shadow_ms: Date.now() - shadowStartedAt,
          });
        } catch (error) {
          logger.info("Inbound AI shadow result", {
            ...shadowMeta,
            shadow: {
              valid: false,
              reason: "shadow_error",
              errors: [String((error && error.message) || "shadow_error")],
            },
            shadow_ms: Date.now() - shadowStartedAt,
          });
        }
      })();
    }

    const isStaffAlertSender = isRestaurantStaffAlertSender(restaurant, normalized);

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

    const isObviousNonOrderMessage =
      isGreetingText(lower) ||
      isAcknowledgementText(lower) ||
      isMenuOrStockQuestion(lower) ||
      looksLikeQuestion(lower, incomingMessage);

    const shouldRunEarlyResolve =
      !isObviousNonOrderMessage &&
      (looksLikeNewOrderAttempt(lower) || /\d/.test(incomingMessage));

    const [customer, activeOrder] = await Promise.all([
      timedDb("upsertCustomerFromChannelMessage", () =>
        customerService.upsertCustomerFromChannelMessage({
          restaurantId,
          channel: normalized.channel,
          channelCustomerId: normalized.channelCustomerId,
          customerPhone: normalized.customerPhone,
          displayName: normalized.displayName || "",
        })
      ),
      timedDb("findActiveOrderByCustomer", () =>
        orderService.findActiveOrderByCustomer({
          restaurantId,
          channel: normalized.channel,
          channelCustomerId: normalized.channelCustomerId,
        })
      ),
    ]);
    const hasBlockingActiveOrder =
      activeOrder && CUSTOMER_BLOCKING_ORDER_STATUSES.includes(activeOrder.status);
    const earlyMatchedResult = !hasBlockingActiveOrder && shouldRunEarlyResolve
      ? await timedDb("resolveRequestedItems_early", async () => {
          try {
            return await orderService.resolveRequestedItems({
              restaurantId,
              messageText: incomingMessage,
            });
          } catch (_error) {
            return { matched: [] };
          }
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

    let preResolvedRequest = null;
    try {
      preResolvedRequest = await timedDb("resolveRequestedItems_precheck", () =>
        orderService.resolveRequestedItems({
          restaurantId,
          messageText: incomingMessage,
        })
      );
    } catch (_error) {
      preResolvedRequest = null;
    }

    if (!hasBlockingActiveOrder) {
      const unavailableItems = Array.isArray(preResolvedRequest && preResolvedRequest.unavailable)
        ? preResolvedRequest.unavailable
        : [];
      if (unavailableItems.length) {
        const menuItems = await timedDb("listAvailableMenuItemsCached_unavailable_precheck", () =>
          listAvailableMenuItemsCached(restaurantId)
        );
        const availableList = (menuItems || [])
          .filter((item) => item && item.available)
          .map((item) => `- ${item.name} - N${item.price}`)
          .join("\n");
        const replyText =
          `Sorry, these item(s) are not available right now: ${unavailableItems.join(", ")}.` +
          `\n\nPlease order again using only available items:\n${availableList}`;

        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "order_contains_unavailable_items",
          replyText,
        };
      }
    }

    if (lower === "cancel") {
      if (activeOrder) {
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

        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );

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

      const guidedResult = await timedRouter(() => handleGuidedSession({
        restaurantId,
        normalized,
        session: existingSession,
        customer,
        providerMessageId,
        sendMessage,
      }));

      if (guidedResult && guidedResult.handled !== false) {
        return guidedResult;
      }
    }

    const routedResult = await timedRouter(() => ruleBasedRouter.tryHandleConversation({
      restaurantId,
      normalized,
      lower,
      incomingMessage,
      hasBlockingActiveOrder,
      seemsLikeStructuredOrder,
      sendMessage,
    }));
    if (routedResult && routedResult.handled !== false) {
      return routedResult;
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

    const preResolvedMatched = Array.isArray(preResolvedRequest && preResolvedRequest.matched)
      ? preResolvedRequest.matched
      : [];
    const hasParsedOrderItems = preResolvedMatched.length > 0;

    if (
      hasBlockingActiveOrder &&
      (looksLikeNewOrderAttempt(lower) || seemsLikeStructuredOrder || hasParsedOrderItems)
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

    if (
      !hasBlockingActiveOrder &&
      (looksLikeNewOrderAttempt(lower) || seemsLikeStructuredOrder || hasParsedOrderItems)
    ) {
      const menuItems = await timedDb("listAvailableMenuItemsCached_structured_order", () =>
        listAvailableMenuItemsCached(restaurantId)
      );
      const selectedItem = resolveMenuSelection(menuItems, incomingMessage);
      const inlineQuantity = extractInlineQuantity(incomingMessage);
      const hasMultipleItems = mentionsMultipleMenuItems(menuItems, incomingMessage);
      const inlineFulfillmentType = extractInlineFulfillmentType(incomingMessage);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(incomingMessage)
          : "";
      const matched = earlyMatchedResult.matched.length
        ? earlyMatchedResult.matched
        : preResolvedMatched;
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

    let lateResolvedRequest = null;
    if (!hasBlockingActiveOrder) {
      try {
        lateResolvedRequest = await timedDb("resolveRequestedItems_late", () =>
          orderService.resolveRequestedItems({
            restaurantId,
            messageText: incomingMessage,
          })
        );
      } catch (_error) {
        lateResolvedRequest = null;
      }
    }

    const lateResolvedMatched = Array.isArray(lateResolvedRequest && lateResolvedRequest.matched)
      ? lateResolvedRequest.matched
      : [];
    if (!hasBlockingActiveOrder && lateResolvedMatched.length) {
      const inlineFulfillmentType = extractInlineFulfillmentType(incomingMessage);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(incomingMessage)
          : "";
      const cartTotal = calculateMatchedTotal(lateResolvedMatched);

      if (inlineFulfillmentType === "pickup") {
        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: FLOW_STATES.AWAITING_CONFIRMATION,
            matched: lateResolvedMatched,
            total: cartTotal,
            fulfillmentType: "pickup",
            deliveryAddress: "",
          }
        );

        const replyText = buildGuidedConfirmPrompt({
          matched: lateResolvedMatched,
          total: cartTotal,
          fulfillmentType: "pickup",
          address: "",
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "guided_confirmation_prompt_late_parse",
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
            matched: lateResolvedMatched,
            total: cartTotal,
            fulfillmentType: "delivery",
            deliveryAddress: inlineAddress,
          }
        );

        const replyText = buildGuidedConfirmPrompt({
          matched: lateResolvedMatched,
          total: cartTotal,
          fulfillmentType: "delivery",
          address: inlineAddress,
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "guided_confirmation_prompt_late_parse",
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
            matched: lateResolvedMatched,
            total: cartTotal,
            fulfillmentType: "delivery",
          }
        );

        const replyText = buildAddressPrompt();
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "guided_address_prompt_late_parse",
          replyText,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: FLOW_STATES.AWAITING_FULFILLMENT_TYPE,
          matched: lateResolvedMatched,
          total: cartTotal,
        }
      );

      const replyText = buildDeliveryOrPickupPrompt({
        matched: lateResolvedMatched,
        total: cartTotal,
      });
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_fulfillment_prompt_late_parse",
        replyText,
      };
    }

    {
      if (looksLikeQuestion(lower, incomingMessage)) {
        const menuItems = await timedDb("listAvailableMenuItemsCached_question_fallback", () =>
          listAvailableMenuItemsCached(restaurantId)
        );
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

      const menuItems = await timedDb("listAvailableMenuItemsCached_invalid_order", () =>
        listAvailableMenuItemsCached(restaurantId)
      );
      const replyText = buildInvalidOrderMessage(menuItems);

      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "invalid_order",
        replyText,
      };
    }
  }

  async function handleInboundEvent({ restaurantId, channel, rawEvent }) {
    const normalized = normalizeInboundInput(
      channel,
      channelGateway.normalizeInboundMessage({ channel, rawEvent })
    );
    const ignoredReason = shouldIgnoreSystemInbound(normalized);
    if (ignoredReason) {
      return withDecisionAndLog(restaurantId, normalized, {
        handled: true,
        ignored: true,
        shouldReply: false,
        type: ignoredReason,
      });
    }
    const result = await processInbound({
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
    return withDecisionAndLog(restaurantId, normalized, result);
  }

  async function handleInboundNormalized({ restaurantId, message, sendMessage = null }) {
    const normalized = normalizeInboundInput(message.channel, message);
    const ignoredReason = shouldIgnoreSystemInbound(normalized);
    if (ignoredReason) {
      return withDecisionAndLog(restaurantId, normalized, {
        handled: true,
        ignored: true,
        shouldReply: false,
        type: ignoredReason,
      });
    }
    const result = await processInbound({
      restaurantId,
      normalized,
      sendMessage,
    });
    return withDecisionAndLog(restaurantId, normalized, result);
  }

  return {
    handleInboundEvent,
    handleInboundNormalized,
  };
}

module.exports = {
  createInboundMessageService,
};
