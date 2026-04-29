const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundMessageService,
} = require("../src/domain/services/inboundMessageService");

function buildService(overrides = {}) {
  return createInboundMessageService({
    inboundEventRepo: {
      markInboundEventIfNew: async () => true,
      ...(overrides.inboundEventRepo || {}),
    },
    menuService: {
      listAvailableMenuItems: async () => [
        { name: "egg", price: 300, available: true },
      ],
      ...(overrides.menuService || {}),
    },
    customerService: {
      upsertCustomerFromChannelMessage: async () => ({ id: "customer-1" }),
      ...(overrides.customerService || {}),
    },
    orderService: {
      findActiveOrderByCustomer: async () => null,
      logInboundMessage: async () => ({}),
      resolveRequestedItems: async () => ({ matched: [] }),
      handleAwaitingCustomerUpdate: async () => ({ handled: false }),
      handleAwaitingCustomerEdit: async () => ({ handled: false }),
      createNewOrderFromInbound: async () => null,
      transitionOrderStatus: async ({ orderId }) => ({ id: orderId, status: "cancelled" }),
      sendMessageToOrderCustomer: async () => ({}),
      ...(overrides.orderService || {}),
    },
    channelGateway: {
      normalizeInboundMessage: ({ rawEvent }) => rawEvent,
      sendMessage: async () => ({}),
      ...(overrides.channelGateway || {}),
    },
    conversationSessionRepo: {
      getSession: async () => null,
      upsertSession: async () => ({}),
      clearSession: async () => ({}),
      ...(overrides.conversationSessionRepo || {}),
    },
    restaurantRepo: {
      getRestaurantById: async () => ({ id: "rest-1", name: "Test Restaurant", bot: {} }),
      ...(overrides.restaurantRepo || {}),
    },
    paymentService: {
      appendCustomerPaymentReference: async () => ({ id: "order-1" }),
      markCustomerPaymentReported: async () => ({ id: "order-1", status: "payment_review" }),
      ...(overrides.paymentService || {}),
    },
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "unknown",
        confidence: 0,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
      }),
      ...(overrides.llmService || {}),
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      ...(overrides.logger || {}),
    },
    menuCooldownMs: 60_000,
    ...(overrides.config || {}),
  });
}

test("duplicate inbound event never produces a reply", async () => {
  const service = buildService({
    inboundEventRepo: {
      markInboundEventIfNew: async () => false,
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000000@c.us",
      customerPhone: "+234000000000",
      text: "hi",
      providerMessageId: "msg-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.duplicate, true);
  assert.equal(result.shouldReply, false);
});

test("menu/greeting response is throttled by cooldown", async () => {
  const service = buildService();

  const first = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000000@c.us",
      customerPhone: "+234000000000",
      text: "menu",
      providerMessageId: "msg-1",
      timestamp: Date.now(),
    },
  });

  const second = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000000@c.us",
      customerPhone: "+234000000000",
      text: "menu",
      providerMessageId: "msg-2",
      timestamp: Date.now(),
    },
  });

  assert.equal(first.shouldReply, true);
  assert.equal(first.type, "guided_menu");

  assert.equal(second.shouldReply, false);
  assert.equal(second.type, "menu_cooldown");
});

test("status inbound never produces a reply", async () => {
  const service = buildService();

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "status@broadcast",
      customerPhone: "",
      text: "reply to status",
      providerMessageId: "msg-status-1",
      timestamp: Date.now(),
      isStatus: true,
    },
  });

  assert.equal(result.shouldReply, false);
  assert.equal(result.ignored, true);
  assert.equal(result.type, "status_broadcast");
});

test("broadcast inbound never produces a reply", async () => {
  const service = buildService();

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "newsletter@broadcast",
      customerPhone: "",
      text: "broadcast payload",
      providerMessageId: "msg-broadcast-1",
      timestamp: Date.now(),
      isBroadcast: true,
    },
  });

  assert.equal(result.shouldReply, false);
  assert.equal(result.ignored, true);
  assert.equal(result.type, "broadcast");
});

test("cancel always cancels active order, even in awaiting_customer_update", async () => {
  let awaitingUpdateCalled = false;
  let transitionCalled = false;

  const service = buildService({
    orderService: {
      findActiveOrderByCustomer: async () => ({
        id: "order-1",
        status: "awaiting_customer_update",
      }),
      handleAwaitingCustomerUpdate: async () => {
        awaitingUpdateCalled = true;
        return { handled: true, order: { id: "order-1" }, reply: "update flow handled" };
      },
      transitionOrderStatus: async ({ toStatus }) => {
        transitionCalled = toStatus === "cancelled";
        return { id: "order-1", status: "cancelled" };
      },
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000000@c.us",
      customerPhone: "+234000000000",
      text: "cancel",
      providerMessageId: "msg-cancel-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(transitionCalled, true);
  assert.equal(awaitingUpdateCalled, false);
  assert.equal(result.shouldReply, true);
  assert.equal(result.type, "cancel_active_order");
  assert.equal(result.orderId, "order-1");
});

test("acknowledgement message gets polite reply when no active order", async () => {
  const service = buildService();

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000000@c.us",
      customerPhone: "+234000000000",
      text: "thank you",
      providerMessageId: "msg-thanks-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.type, "acknowledgement");
  assert.match(result.replyText, /Reply MENU/i);
});

test("acknowledgement message keeps active order context", async () => {
  const service = buildService({
    orderService: {
      findActiveOrderByCustomer: async () => ({
        id: "order-2",
        status: "preparing",
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000000@c.us",
      customerPhone: "+234000000000",
      text: "okay",
      providerMessageId: "msg-ok-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.type, "acknowledgement");
  assert.match(result.replyText, /in progress/i);
  assert.match(result.replyText, /CANCEL/i);
});

test("decision metadata is attached for guided menu flow", async () => {
  const service = buildService();

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000001@c.us",
      customerPhone: "+234000000001",
      text: "menu",
      providerMessageId: "msg-decision-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "guided_menu");
  assert.equal(result.decision.handler, "guided_flow_start");
  assert.equal(result.decision.intent, "menu_request");
});

test("decision metadata is attached for cancel flow", async () => {
  const service = buildService({
    orderService: {
      findActiveOrderByCustomer: async () => ({
        id: "order-3",
        status: "preparing",
      }),
      transitionOrderStatus: async ({ orderId }) => ({ id: orderId, status: "cancelled" }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000002@c.us",
      customerPhone: "+234000000002",
      text: "cancel",
      providerMessageId: "msg-decision-2",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "cancel_active_order");
  assert.equal(result.decision.handler, "active_order_cancel");
  assert.equal(result.decision.intent, "cancel_order");
});

test("decision metadata is attached for llm direct replies", async () => {
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "delivery_question",
        confidence: 0.92,
        replyText: "Yes, we deliver. Please share your area.",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: true,
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000003@c.us",
      customerPhone: "+234000000003",
      text: "do you deliver to ikeja?",
      providerMessageId: "msg-decision-3",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "llm_delivery_question");
  assert.equal(result.decision.handler, "llm_direct");
  assert.equal(result.decision.intent, "delivery_question");
});

test("llm medium confidence produces clarification reply", async () => {
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "recommendation",
        confidence: 0.4,
        replyText: "Try egg.",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
      }),
    },
    menuService: {
      listAvailableMenuItems: async () => [
        { name: "egg", price: 300, available: true },
        { name: "rice", price: 800, available: true },
      ],
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000004@c.us",
      customerPhone: "+234000000004",
      text: "what do you recommend?",
      providerMessageId: "msg-decision-4",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "llm_clarify_recommendation");
  assert.equal(result.decision.handler, "llm_clarification");
  assert.equal(result.decision.intent, "recommendation");
  assert.match(result.replyText, /recommendation by budget or taste/i);
});

test("structured numeric order asks delivery or pickup before creating order", async () => {
  let createOrderCalled = false;
  const service = buildService({
    orderService: {
      resolveRequestedItems: async () => ({
        matched: [
          { menuItemId: "m1", name: "Amala", price: 500, quantity: 1, subtotal: 500 },
          { menuItemId: "m2", name: "Beans", price: 500, quantity: 2, subtotal: 1000 },
        ],
        unavailable: [],
      }),
      createNewOrderFromInbound: async () => {
        createOrderCalled = true;
        return { id: "order-should-not-be-created" };
      },
    },
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Amala", price: 500, available: true },
        { id: "m2", name: "Beans", price: 500, available: true },
      ],
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000010@c.us",
      customerPhone: "+234000000010",
      text: "1 Amala with 2 beans",
      providerMessageId: "msg-structured-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(createOrderCalled, false);
  assert.equal(result.shouldReply, true);
  assert.match(result.replyText, /Delivery or Pickup/i);
  assert.match(result.replyText, /Reply D or P/i);
});

test("structured numeric order with active pending order returns active-order guard", async () => {
  const service = buildService({
    orderService: {
      findActiveOrderByCustomer: async () => ({
        id: "order-pending-1",
        status: "pending_confirmation",
      }),
      resolveRequestedItems: async () => ({
        matched: [
          { menuItemId: "m1", name: "Amala", price: 500, quantity: 1, subtotal: 500 },
        ],
        unavailable: [],
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000011@c.us",
      customerPhone: "+234000000011",
      text: "1 Amala",
      providerMessageId: "msg-structured-active-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "active_order_exists");
  assert.equal(result.shouldReply, true);
  assert.match(result.replyText, /active order in progress/i);
});

test("llm clarification uses extracted budget entity", async () => {
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "recommendation",
        confidence: 0.42,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
        entities: {
          items: [],
          quantity: 0,
          fulfillmentType: "",
          location: "",
          budget: 2500,
        },
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000006@c.us",
      customerPhone: "+234000000006",
      text: "recommend food under 2500",
      providerMessageId: "msg-entity-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "llm_clarify_recommendation");
  assert.equal(result.decision.handler, "llm_clarification");
  assert.equal(result.decision.entities.budget, 2500);
  assert.match(result.replyText, /under N2500/i);
});

test("llm place_order with entities asks smart confirmation", async () => {
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { name: "egg", price: 300, available: true },
        { name: "rice", price: 800, available: true },
      ],
    },
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "place_order",
        confidence: 0.77,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
        entities: {
          items: ["rice"],
          quantity: 2,
          fulfillmentType: "",
          location: "",
          budget: 0,
        },
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000007@c.us",
      customerPhone: "+234000000007",
      text: "2 rice please",
      providerMessageId: "msg-entity-2",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "llm_order_entity_confirmation");
  assert.equal(result.decision.handler, "llm_order_entity_confirmation");
  assert.equal(result.decision.intent, "place_order");
  assert.match(result.replyText, /2 rice/i);
  assert.match(result.replyText, /delivery or pickup/i);
});

test("recent conversation context is passed to llm on follow-up", async () => {
  const observedContexts = [];
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async (payload) => {
        observedContexts.push(String(payload.conversationContext || ""));
        return {
          intent: "unknown",
          confidence: 0,
          replyText: "",
          shouldStartGuidedFlow: false,
          shouldHandleDirectly: false,
        };
      },
    },
  });

  await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000005@c.us",
      customerPhone: "+234000000005",
      text: "what is your menu",
      providerMessageId: "msg-context-1",
      timestamp: Date.now(),
    },
  });

  await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000005@c.us",
      customerPhone: "+234000000005",
      text: "can you recommend",
      providerMessageId: "msg-context-2",
      timestamp: Date.now(),
    },
  });

  assert.equal(observedContexts.length >= 1, true);
  const latest = observedContexts[observedContexts.length - 1];
  assert.match(latest, /user:/i);
  assert.match(latest, /assistant:/i);
});
