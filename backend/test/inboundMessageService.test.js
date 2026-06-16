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
      listOrders: async () => [],
      listOrderMessages: async () => ({ messages: [] }),
      getOrder: async () => {
        throw new Error("Order not found");
      },
      confirmOrder: async ({ orderId }) => ({ id: orderId, status: "confirmed" }),
      rejectOrder: async ({ orderId }) => ({ id: orderId, status: "cancelled" }),
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
        entities: { items: [], fulfillmentType: "", location: "" },
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

test("generic order intent starts guided menu instead of invalid order", async () => {
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Jollof Rice", price: 700, available: true },
        { id: "m2", name: "Chicken", price: 2000, available: true },
      ],
    },
    orderService: {
      resolveRequestedItems: async () => ({ matched: [] }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000099@c.us",
      customerPhone: "+234000000099",
      text: "I want to order food",
      providerMessageId: "msg-generic-order-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.type, "guided_menu");
  assert.equal(result.decision.handler, "guided_flow_start");
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
  // After extraction-only refactor, LLM never writes replies. Questions the LLM cannot
  // classify as an actionable intent return `unknown`, which triggers the UNKNOWN template.
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "unknown",
        confidence: 0.7,
        entities: { items: [], fulfillmentType: "", location: "" },
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

  assert.equal(result.type, "llm_unknown");
  assert.equal(result.decision.handler, "llm_unknown_template");
  assert.equal(result.shouldReply, true);
  assert.match(result.replyText, /didn't understand|HI|order directly/i);
});

test("llm medium confidence produces clarification reply", async () => {
  // After extraction-only refactor, "what do you recommend?" is classified as
  // menu_request (the LLM prompt maps recommendation intent to menu_request).
  // The backend shows the guided menu instead of an LLM-written clarification.
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "menu_request",
        confidence: 0.85,
        entities: { items: [], fulfillmentType: "", location: "" },
      }),
    },
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "e1", name: "egg", price: 300, available: true },
        { id: "r1", name: "rice", price: 800, available: true },
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

  assert.equal(result.type, "guided_menu");
  assert.equal(result.shouldReply, true);
  assert.match(result.replyText, /egg|rice/i);
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

test("llm place_order with location entity routes to delivery pre-seed", async () => {
  // Verifies that a fulfillmentType entity extracted by the LLM is used by the
  // backend to pre-seed the guided flow at the correct state.
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "r1", name: "rice", price: 800, available: true },
      ],
    },
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "place_order",
        confidence: 0.9,
        entities: {
          items: [{ name: "rice", quantity: 1 }],
          fulfillmentType: "delivery",
          location: "Yaba",
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
      text: "deliver to Yaba please",
      providerMessageId: "msg-entity-1",
      timestamp: Date.now(),
    },
  });

  // delivery pre-seed → AWAITING_ADDRESS
  assert.equal(result.type, "guided_preseed_address");
  assert.equal(result.shouldReply, true);
  assert.match(result.replyText, /delivery address/i);
});

test("llm place_order with entities asks smart confirmation", async () => {
  // After extraction-only refactor: LLM extracts {name, quantity} items.
  // Backend matches them to menu, then routes to guided pre-seed flow.
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "e1", name: "egg", price: 300, available: true },
        { id: "r1", name: "rice", price: 800, available: true },
      ],
    },
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "place_order",
        confidence: 0.9,
        entities: {
          items: [{ name: "rice", quantity: 2 }],
          fulfillmentType: "",
          location: "",
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

  // no fulfillmentType → AWAITING_FULFILLMENT_TYPE
  assert.equal(result.type, "guided_preseed_fulfillment");
  assert.equal(result.decision.intent, "place_order");
  assert.match(result.replyText, /2x rice/i);
  assert.match(result.replyText, /Delivery or pickup/i);
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
          entities: { items: [], fulfillmentType: "", location: "" },
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

test("who are you uses conversational fallback not invalid order", async () => {
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "unknown",
        confidence: 0.2,
        entities: { items: [], fulfillmentType: "", location: "" },
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000008@c.us",
      customerPhone: "+234000000008",
      text: "Who are you",
      providerMessageId: "msg-conv-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.type, "llm_unknown");
  assert.equal(result.decision.handler, "llm_unknown_template");
  assert.doesNotMatch(result.replyText, /couldn't detect a valid order/i);
});

test("parser-only mode bypasses LLM direct-reply path", async () => {
  const service = buildService({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "unknown",
        confidence: 0.7,
        entities: { items: [], fulfillmentType: "", location: "" },
      }),
    },
    config: {
      llmParserOnlyMode: true,
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000012@c.us",
      customerPhone: "+234000000012",
      text: "do you deliver to ikeja?",
      providerMessageId: "msg-parser-only-1",
      timestamp: Date.now(),
    },
  });

  assert.notEqual(result.type, "llm_delivery_question");
});

test("parser-only mode asks rephrase when itemized parse fails", async () => {
  const service = buildService({
    orderService: {
      resolveRequestedItems: async () => ({ matched: [], unavailable: [] }),
    },
    config: {
      llmParserOnlyMode: true,
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000013@c.us",
      customerPhone: "+234000000013",
      text: "i want 2 sushi",
      providerMessageId: "msg-parser-only-2",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "order_rephrase_prompt");
  assert.match(String(result.replyText || ""), /rephrase/i);
});

test("parser-only mode routes generic order intent to guided menu", async () => {
  const service = buildService({
    config: {
      llmParserOnlyMode: true,
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000014@c.us",
      customerPhone: "+234000000014",
      text: "I would like to order food",
      providerMessageId: "msg-parser-only-3",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "guided_menu");
  assert.match(String(result.replyText || ""), /Here is our menu today|Here's our menu|our menu/i);
});

test("smalltalk hello gets friendly greeting response", async () => {
  const service = buildService({
    config: {
      llmParserOnlyMode: true,
    },
    restaurantRepo: {
      getRestaurantById: async () => ({ id: "rest-1", name: "Mama Tee", bot: {} }),
    },
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Chapman", price: 1000, available: true },
        { id: "m2", name: "Fried Rice", price: 1000, available: true },
      ],
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000015@c.us",
      customerPhone: "+234000000015",
      text: "Hello",
      providerMessageId: "msg-smalltalk-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "greeting");
  assert.match(String(result.replyText || ""), /Mama Tee|menu/i);
});

test("smalltalk how-are-you gets non-loop response", async () => {
  const service = buildService({
    config: {
      llmParserOnlyMode: true,
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000016@c.us",
      customerPhone: "+234000000016",
      text: "How are you",
      providerMessageId: "msg-smalltalk-2",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "smalltalk_how_are_you");
  assert.match(String(result.replyText || ""), /doing great|menu/i);
});

test("smalltalk hungry gets helpful ordering prompt", async () => {
  const service = buildService({
    config: {
      llmParserOnlyMode: true,
    },
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Chapman", price: 1000, available: true },
        { id: "m2", name: "Fried Rice", price: 1000, available: true },
      ],
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000017@c.us",
      customerPhone: "+234000000017",
      text: "I'm hungry what can I get",
      providerMessageId: "msg-smalltalk-3",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "smalltalk_hungry");
  assert.match(String(result.replyText || ""), /Reply with item names and quantity/i);
});

test("parser-only slang classification routes menu request deterministically", async () => {
  const service = buildService({
    llmService: {
      classifyIntent: async () => ({ intent: "menu_request" }),
    },
    config: {
      llmParserOnlyMode: true,
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000018@c.us",
      customerPhone: "+234000000018",
      text: "abeg wetin una get",
      providerMessageId: "msg-slang-intent-1",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "guided_menu");
});

test("parser-only slang classification routes smalltalk deterministically", async () => {
  const service = buildService({
    llmService: {
      classifyIntent: async () => ({ intent: "smalltalk" }),
    },
    config: {
      llmParserOnlyMode: true,
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "234000000019@c.us",
      customerPhone: "+234000000019",
      text: "how far",
      providerMessageId: "msg-slang-intent-2",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "smalltalk_how_are_you");
});

test("staff hash confirm is rejected for numbers that do not match the restaurant profile phone", async () => {
  const service = buildService({
    restaurantRepo: {
      getRestaurantById: async () => ({
        id: "rest-1",
        name: "Test Restaurant",
        phone: "08011112222",
        bot: {},
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "2348000000000@c.us",
      customerPhone: "+2348000000000",
      text: "#confirm ord-1",
      providerMessageId: "msg-staff-unauthorized",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "staff_hash_unauthorized");
  assert.match(String(result.replyText || ""), /restaurant profile phone/i);
});

test("staff hash confirm is rejected when no Servra alert was sent to that number", async () => {
  const service = buildService({
    restaurantRepo: {
      getRestaurantById: async () => ({
        id: "rest-1",
        name: "Test Restaurant",
        phone: "08011112222",
        bot: {},
      }),
    },
    orderService: {
      getOrder: async ({ orderId }) => ({
        id: orderId,
        status: "pending_confirmation",
      }),
      listOrderMessages: async () => ({
        messages: [],
      }),
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "08011112222@c.us",
      customerPhone: "08011112222",
      text: "#confirm ord-2",
      providerMessageId: "msg-staff-no-alert",
      timestamp: Date.now(),
    },
  });

  assert.equal(result.type, "staff_hash_alert_not_found");
  assert.match(String(result.replyText || ""), /could not find an order alert/i);
});

test("staff hash confirm succeeds only when the Servra alert was sent to that restaurant number", async () => {
  let confirmedOrderId = "";
  const service = buildService({
    restaurantRepo: {
      getRestaurantById: async () => ({
        id: "rest-1",
        name: "Test Restaurant",
        phone: "08011112222",
        bot: {},
      }),
    },
    orderService: {
      getOrder: async ({ orderId }) => ({
        id: orderId,
        status: "pending_confirmation",
      }),
      listOrderMessages: async () => ({
        messages: [
          {
            direction: "outbound",
            channelCustomerId: "08011112222",
            metadata: {
              internalAlert: true,
              messageType: "restaurant_order_alert",
              alertRecipient: "08011112222",
              deliveryStatus: "sent",
            },
          },
        ],
      }),
      confirmOrder: async ({ orderId }) => {
        confirmedOrderId = orderId;
        return {
          id: orderId,
          status: "confirmed",
        };
      },
    },
  });

  const result = await service.handleInboundNormalized({
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "08011112222@c.us",
      customerPhone: "08011112222",
      text: "#confirm ord-3",
      providerMessageId: "msg-staff-confirm",
      timestamp: Date.now(),
    },
  });

  assert.equal(confirmedOrderId, "ord-3");
  assert.equal(result.type, "staff_hash_confirmed_order");
  assert.match(String(result.replyText || ""), /Customer has been updated/i);
});
