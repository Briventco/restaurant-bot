const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createChatOrchestrator,
} = require("../src/domain/services/chatOrchestrator");

function buildOrchestrator(overrides = {}) {
  const sentMessages = [];
  const sessions = [];

  const orchestrator = createChatOrchestrator({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "place_order",
        confidence: 0.9,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
        suggestedAction: "create_order",
        entities: {
          items: ["Jollof Rice", "Chicken", "Water", "Chapman"],
          quantity: 6,
          fulfillmentType: "",
          location: "",
          budget: 0,
        },
      }),
      ...(overrides.llmService || {}),
    },
    resolveRequestedItems: async () => ({
      matched: [
        { menuItemId: "m1", name: "Jollof Rice", price: 1500, quantity: 2, subtotal: 3000 },
        { menuItemId: "m2", name: "Chicken", price: 1000, quantity: 1, subtotal: 1000 },
        { menuItemId: "m3", name: "Water", price: 500, quantity: 2, subtotal: 1000 },
        { menuItemId: "m4", name: "Chapman", price: 1200, quantity: 1, subtotal: 1200 },
      ],
      unavailable: [],
      invalidQuantities: [],
    }),
    conversationSessionRepo: {
      upsertSession: async (_restaurantId, _channel, _chatId, session) => {
        sessions.push(session);
      },
    },
    flowStates: {
      AWAITING_ITEM: "awaiting_item",
      AWAITING_FULFILLMENT_TYPE: "awaiting_fulfillment_type",
      AWAITING_CONFIRMATION: "awaiting_confirmation",
      AWAITING_ADDRESS: "awaiting_address",
    },
    sendText: async (_sendMessage, to, text) => {
      sentMessages.push({ to, text });
    },
    ...(overrides.dependencies || {}),
  });

  return {
    orchestrator,
    sentMessages,
    sessions,
  };
}

function buildLlmContext() {
  return {
    restaurantId: "rest-1",
    normalized: {
      text: "Yes, 2 portions of jollof rice, 1 chicken, two water and one Chapman",
      channel: "whatsapp-web",
      channelCustomerId: "234000000100@c.us",
      conversationContext: "",
    },
    restaurant: {
      id: "rest-1",
      name: "Test Kitchen",
    },
    menuItems: [
      { id: "m1", name: "Jollof Rice", price: 1500, available: true },
      { id: "m2", name: "Chicken", price: 1000, available: true },
      { id: "m3", name: "Water", price: 500, available: true },
      { id: "m4", name: "Chapman", price: 1200, available: true },
    ],
    sendMessage: {},
  };
}

test("suggested create_order preserves each parsed item quantity", async () => {
  const { orchestrator, sentMessages, sessions } = buildOrchestrator();

  const result = await orchestrator.maybeHandleWithLlm(buildLlmContext());

  assert.equal(result.type, "guided_preseed_fulfillment");
  assert.equal(result.shouldReply, true);
  assert.match(result.replyText, /2x Jollof Rice/i);
  assert.match(result.replyText, /1x Chicken/i);
  assert.match(result.replyText, /2x Water/i);
  assert.match(result.replyText, /1x Chapman/i);
  assert.doesNotMatch(result.replyText, /6x Jollof Rice/i);
  assert.equal(sessions[0].matched[0].quantity, 2);
  assert.equal(sessions[0].matched[1].quantity, 1);
  assert.equal(sessions[0].matched[2].quantity, 2);
  assert.equal(sessions[0].matched[3].quantity, 1);
  assert.equal(sentMessages.length, 1);
});

test("place_order confirmation never fans a global quantity across all items", async () => {
  const { orchestrator } = buildOrchestrator({
    llmService: {
      classifyRestaurantMessage: async () => ({
        intent: "place_order",
        confidence: 0.8,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
        suggestedAction: "",
        entities: {
          items: ["Jollof Rice", "Chicken", "Water", "Chapman"],
          quantity: 6,
          fulfillmentType: "delivery",
          location: "",
          budget: 0,
        },
      }),
    },
  });

  const result = await orchestrator.maybeHandleWithLlm(buildLlmContext());

  assert.equal(result.type, "llm_order_entity_confirmation");
  assert.match(result.replyText, /2x Jollof Rice/i);
  assert.match(result.replyText, /1x Chicken/i);
  assert.match(result.replyText, /2x Water/i);
  assert.match(result.replyText, /1x Chapman/i);
  assert.doesNotMatch(result.replyText, /6x Jollof Rice/i);
  assert.doesNotMatch(result.replyText, /6x Water/i);
  assert.doesNotMatch(result.replyText, /6x Chapman/i);
});
