const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateRestaurantInboundPolicy,
} = require("../src/routes/messageRoutes");

function baseInbound(overrides = {}) {
  return {
    channel: "whatsapp-web",
    channelCustomerId: "234000000000@c.us",
    customerPhone: "+234000000000",
    text: "hello",
    type: "chat",
    isFromMe: false,
    isStatus: false,
    isBroadcast: false,
    ...overrides,
  };
}

test("restaurant bot pause blocks inbound replies", () => {
  const decision = evaluateRestaurantInboundPolicy(
    {
      bot: { enabled: false },
    },
    baseInbound()
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "bot_paused");
});

test("allowed chat list blocks unknown chats", () => {
  const decision = evaluateRestaurantInboundPolicy(
    {
      bot: { allowedChatIds: ["111111111111@c.us"] },
    },
    baseInbound()
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "chat_not_allowed");
});

test("allowed phone prefixes can allow traffic", () => {
  const allowed = evaluateRestaurantInboundPolicy(
    {
      bot: { allowedPhonePrefixes: ["234"] },
    },
    baseInbound()
  );

  const blocked = evaluateRestaurantInboundPolicy(
    {
      bot: { allowedPhonePrefixes: ["44"] },
    },
    baseInbound()
  );

  assert.equal(allowed.allowed, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "phone_prefix_not_allowed");
});
