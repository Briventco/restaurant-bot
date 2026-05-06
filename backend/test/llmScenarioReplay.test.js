const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundMessageService,
} = require("../src/domain/services/inboundMessageService");
const {
  createChatOrchestrator,
} = require("../src/domain/services/chatOrchestrator");

function buildReplayService({ loggerSink }) {
  const menuItems = [
    { id: "m1", name: "Jollof Rice", price: 1500, available: true },
    { id: "m2", name: "Chicken", price: 1200, available: true },
    { id: "m3", name: "Beans", price: 900, available: true },
  ];

  const sessionByKey = new Map();
  let activeOrder = null;

  function keyOf(restaurantId, channel, channelCustomerId) {
    return `${restaurantId}:${channel}:${channelCustomerId}`;
  }

  function resolveRequestedItems(messageText) {
    const text = String(messageText || "").toLowerCase();
    const matched = [];

    if (text.includes("jollof")) {
      const quantity = /\bx2\b|\b2\b/.test(text) ? 2 : 1;
      matched.push({
        menuItemId: "m1",
        name: "Jollof Rice",
        price: 1500,
        quantity,
        subtotal: 1500 * quantity,
      });
    }

    if (text.includes("chicken")) {
      matched.push({
        menuItemId: "m2",
        name: "Chicken",
        price: 1200,
        quantity: 1,
        subtotal: 1200,
      });
    }

    return { matched, unavailable: [] };
  }

  const service = createInboundMessageService({
    inboundEventRepo: {
      markInboundEventIfNew: async () => true,
    },
    menuService: {
      listAvailableMenuItems: async () => menuItems,
    },
    customerService: {
      upsertCustomerFromChannelMessage: async () => ({ id: "cust-1" }),
    },
    orderService: {
      findActiveOrderByCustomer: async () => activeOrder,
      listCurrentOrders: async () => (activeOrder ? [activeOrder] : []),
      resolveRequestedItems: async ({ messageText }) => resolveRequestedItems(messageText),
      handleAwaitingCustomerUpdate: async () => ({ handled: false }),
      handleAwaitingCustomerEdit: async () => ({ handled: false }),
      createNewOrderFromInbound: async () => null,
      createGuidedOrder: async ({ matched, fulfillmentType, deliveryAddress, channelCustomerId }) => {
        const total = (matched || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
        activeOrder = {
          id: "order-1",
          status: "awaiting_payment",
          matched,
          total,
          fulfillmentType: fulfillmentType || "delivery",
          deliveryAddress: deliveryAddress || "Yaba",
          channelCustomerId,
        };
        return activeOrder;
      },
      createGuidedOrderFromItems: async ({ matched, fulfillmentType, deliveryAddress, channelCustomerId }) => {
        const total = (matched || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
        activeOrder = {
          id: "order-1",
          status: "awaiting_payment",
          matched,
          total,
          fulfillmentType: fulfillmentType || "delivery",
          deliveryAddress: deliveryAddress || "Yaba",
          channelCustomerId,
        };
        return activeOrder;
      },
      updatePendingOrderFromCustomer: async ({ matched, fulfillmentType, deliveryAddress }) => {
        const total = (matched || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
        activeOrder = {
          ...(activeOrder || {}),
          id: (activeOrder && activeOrder.id) || "order-1",
          status: "pending_confirmation",
          matched,
          total,
          fulfillmentType: fulfillmentType || (activeOrder && activeOrder.fulfillmentType) || "",
          deliveryAddress: deliveryAddress || (activeOrder && activeOrder.deliveryAddress) || "",
        };
        return activeOrder;
      },
      transitionOrderStatus: async ({ orderId, toStatus }) => {
        if (activeOrder && activeOrder.id === orderId) {
          activeOrder = { ...activeOrder, status: toStatus };
        }
        return activeOrder || { id: orderId, status: toStatus };
      },
      logInboundMessage: async () => ({}),
      sendMessageToOrderCustomer: async (_order, _text) => ({}),
    },
    channelGateway: {
      normalizeInboundMessage: ({ rawEvent }) => rawEvent,
      sendMessage: async () => ({}),
    },
    conversationSessionRepo: {
      getSession: async (restaurantId, channel, channelCustomerId) =>
        sessionByKey.get(keyOf(restaurantId, channel, channelCustomerId)) || null,
      upsertSession: async (restaurantId, channel, channelCustomerId, patch) => {
        const key = keyOf(restaurantId, channel, channelCustomerId);
        const current = sessionByKey.get(key) || {};
        const next = { ...current, ...patch };
        sessionByKey.set(key, next);
        return next;
      },
      clearSession: async (restaurantId, channel, channelCustomerId) => {
        sessionByKey.delete(keyOf(restaurantId, channel, channelCustomerId));
      },
    },
    restaurantRepo: {
      getRestaurantById: async () => ({ id: "rest-1", name: "Test Kitchen", bot: {} }),
    },
    paymentService: {
      appendCustomerPaymentReference: async () => activeOrder || { id: "order-1" },
      markCustomerPaymentReported: async () => {
        if (activeOrder) {
          activeOrder = { ...activeOrder, status: "payment_review" };
        }
        return activeOrder || { id: "order-1", status: "payment_review" };
      },
    },
    llmService: {
      classifyRestaurantMessage: async ({ messageText }) => {
        const text = String(messageText || "").toLowerCase();
        if (text.includes("payment") && text.includes("confirmed")) {
          return {
            intent: "support",
            confidence: 0.9,
            replyText: "Your payment has been confirmed.",
            shouldStartGuidedFlow: false,
            shouldHandleDirectly: true,
            suggestedAction: "answer_question",
            entities: { items: [], quantity: 0, fulfillmentType: "", location: "", budget: 0 },
          };
        }
        if (text.includes("delivered") || text.includes("delivery")) {
          return {
            intent: "delivery_question",
            confidence: 0.92,
            replyText: "Delivery is usually 30-45 minutes after confirmation.",
            shouldStartGuidedFlow: false,
            shouldHandleDirectly: true,
            suggestedAction: "answer_question",
            entities: { items: [], quantity: 0, fulfillmentType: "", location: "Yaba", budget: 0 },
          };
        }
        return {
          intent: "unknown",
          confidence: 0.2,
          replyText: "",
          shouldStartGuidedFlow: false,
          shouldHandleDirectly: false,
          suggestedAction: "clarify",
          entities: { items: [], quantity: 0, fulfillmentType: "", location: "", budget: 0 },
        };
      },
    },
    logger: {
      info: (message, payload) => loggerSink.push({ level: "info", message, payload }),
      warn: () => {},
      error: () => {},
    },
    menuCooldownMs: 1000,
  });

  return { service, sessionByKey };
}

test("scripted 10-turn replay exercises rules, memory, and LLM context logging", async () => {
  const loggerSink = [];
  const { service, sessionByKey } = buildReplayService({ loggerSink });
  const customerId = "234000000200@c.us";

  const turns = [
    "Hi",
    "I want to order food",
    "What do you have?",
    "Give me jollof rice and chicken",
    "Actually make the rice x2",
    "How much is that total?",
    "Ok confirm the order",
    "Has my payment been confirmed?",
    "When will it be delivered?",
    "Cancel the order",
  ];

  const outputs = [];

  for (let i = 0; i < turns.length; i += 1) {
    const result = await service.handleInboundNormalized({
      restaurantId: "rest-1",
      message: {
        channel: "whatsapp-web",
        channelCustomerId: customerId,
        customerPhone: "+234000000200",
        text: turns[i],
        providerMessageId: `msg-replay-${i + 1}`,
        timestamp: Date.now() + i,
      },
    });
    outputs.push(result);
  }

  assert.equal(outputs.length, 10);
  assert.match(String(outputs[2].replyText || ""), /we have|menu|jollof/i);
  assert.ok(outputs[3].shouldReply);
  assert.ok(outputs[9].type === "cancel_active_order" || /cancel/i.test(String(outputs[9].replyText || "")));

  sessionByKey.delete("rest-1:whatsapp-web:234000000200@c.us");
  const paymentStatusAfterFlow = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: customerId,
      customerPhone: "+234000000200",
      text: "Has my payment been confirmed?",
      providerMessageId: "msg-replay-payment-followup",
      timestamp: Date.now() + 1000,
    },
  });
  assert.match(String(paymentStatusAfterFlow.replyText || ""), /cannot confirm payment status|verify/i);

  const key = "rest-1:whatsapp-web:234000000200@c.us";
  const finalSession = sessionByKey.get(key) || {};
  const memoryTurns = Array.isArray(finalSession.llmMemoryTurns) ? finalSession.llmMemoryTurns : [];
  assert.ok(memoryTurns.length <= 4);

  const llmContextLogs = loggerSink.filter((entry) => entry.message === "[LLM_CONTEXT]");
  assert.ok(llmContextLogs.length >= 1);
});

test("grounding guard rewrites payment-confirmation hallucination", async () => {
  const sent = [];
  const orchestrator = createChatOrchestrator({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "support",
        confidence: 0.95,
        replyText: "Payment confirmed. Your order is finalized.",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: true,
        suggestedAction: "answer_question",
        entities: { items: [], quantity: 0, fulfillmentType: "", location: "", budget: 0 },
      }),
    },
    resolveRequestedItems: async () => ({ matched: [], unavailable: [] }),
    conversationSessionRepo: {
      upsertSession: async () => ({}),
    },
    flowStates: {
      AWAITING_ITEM: "awaiting_item",
      AWAITING_FULFILLMENT_TYPE: "awaiting_fulfillment_type",
      AWAITING_CONFIRMATION: "awaiting_confirmation",
      AWAITING_ADDRESS: "awaiting_address",
    },
    sendText: async (_sendMessage, _to, text) => sent.push(text),
    logger: { info: () => {} },
  });

  const result = await orchestrator.maybeHandleWithLlm({
    restaurantId: "rest-1",
    normalized: {
      text: "Has my payment been confirmed?",
      channel: "whatsapp-web",
      channelCustomerId: "234000000201@c.us",
      conversationContext: "",
    },
    restaurant: { id: "rest-1", name: "Test Kitchen" },
    menuItems: [{ id: "m1", name: "Jollof Rice", price: 1500, available: true }],
    sendMessage: {},
    activeOrder: null,
    sessionState: null,
  });

  assert.ok(result && result.shouldReply === true);
  assert.match(String(sent[0] || ""), /cannot confirm payment status|verify/i);
});
