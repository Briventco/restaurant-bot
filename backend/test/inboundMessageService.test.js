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
      transitionOrderStatus: async ({ orderId }) => ({ id: orderId, status: "cancelled" }),
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
