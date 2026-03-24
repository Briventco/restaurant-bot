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
      handleAwaitingCustomerUpdate: async () => ({ handled: false }),
      handleAwaitingCustomerEdit: async () => ({ handled: false }),
      createNewOrderFromInbound: async () => null,
      sendMessageToOrderCustomer: async () => ({}),
      ...(overrides.orderService || {}),
    },
    channelGateway: {
      normalizeInboundMessage: ({ rawEvent }) => rawEvent,
      sendMessage: async () => ({}),
      ...(overrides.channelGateway || {}),
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
      text: "hi",
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
  assert.equal(first.type, "menu");

  assert.equal(second.shouldReply, false);
  assert.equal(second.type, "menu_cooldown");
});
