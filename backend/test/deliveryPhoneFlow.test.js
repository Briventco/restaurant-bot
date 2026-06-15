"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundMessageService,
} = require("../src/domain/services/inboundMessageService");

// ── Minimal service builder ────────────────────────────────────────────────

let sessionStore = {};

function buildService(overrides = {}) {
  sessionStore = {};

  return createInboundMessageService({
    inboundEventRepo: {
      markInboundEventIfNew: async () => true,
      ...(overrides.inboundEventRepo || {}),
    },
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Pancakes", price: 2500, available: true },
        { id: "m2", name: "Zobo", price: 700, available: true },
      ],
      ...(overrides.menuService || {}),
    },
    customerService: {
      upsertCustomerFromChannelMessage: async () => ({ id: "cust-1" }),
      ...(overrides.customerService || {}),
    },
    orderService: {
      findActiveOrderByCustomer: async () => null,
      logInboundMessage: async () => ({}),
      resolveRequestedItems: async () => ({ matched: [] }),
      handleAwaitingCustomerUpdate: async () => ({ handled: false }),
      handleAwaitingCustomerEdit: async () => ({ handled: false }),
      createNewOrderFromInbound: async () => null,
      createGuidedOrder: async (params) => ({
        id: "order-guided-1",
        restaurantId: params.restaurantId,
        channel: params.channel,
        channelCustomerId: params.channelCustomerId,
        matched: [{ name: params.menuItem.name, quantity: params.quantity, price: params.menuItem.price, subtotal: params.menuItem.price * params.quantity }],
        fulfillmentType: params.fulfillmentType,
        deliveryAddress: params.deliveryAddress,
        deliveryPhone: params.deliveryPhone || "",
        total: params.menuItem.price * params.quantity,
      }),
      createGuidedOrderFromItems: async (params) => ({
        id: "order-guided-items-1",
        restaurantId: params.restaurantId,
        channel: params.channel,
        channelCustomerId: params.channelCustomerId,
        matched: params.matched,
        fulfillmentType: params.fulfillmentType,
        deliveryAddress: params.deliveryAddress,
        deliveryPhone: params.deliveryPhone || "",
        total: params.matched.reduce((s, i) => s + (i.subtotal || 0), 0),
      }),
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
      getSession: async (restaurantId, channel, cid) =>
        sessionStore[`${restaurantId}:${channel}:${cid}`] || null,
      upsertSession: async (restaurantId, channel, cid, data) => {
        const key = `${restaurantId}:${channel}:${cid}`;
        sessionStore[key] = { ...(sessionStore[key] || {}), ...data };
      },
      clearSession: async (restaurantId, channel, cid) => {
        delete sessionStore[`${restaurantId}:${channel}:${cid}`];
      },
      ...(overrides.conversationSessionRepo || {}),
    },
    restaurantRepo: {
      getRestaurantById: async () => ({
        id: "rest-1",
        name: "Test Cafe",
        bot: { enabled: true },
      }),
      ...(overrides.restaurantRepo || {}),
    },
    paymentService: {
      appendCustomerPaymentReference: async () => ({ id: "order-1" }),
      markCustomerPaymentReported: async () => ({ id: "order-1", status: "payment_review" }),
      ...(overrides.paymentService || {}),
    },
    deliveryZoneRepo: null,
    llmService: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    menuCooldownMs: 0,
    ...(overrides.config || {}),
  });
}

function msg(text, id = `msg-${Date.now()}-${Math.random()}`) {
  return {
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "08099990000@c.us",
      customerPhone: "+2348099990000",
      text,
      providerMessageId: id,
      timestamp: Date.now(),
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getSession() {
  return sessionStore["rest-1:whatsapp-web:08099990000@c.us"] || null;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("delivery flow: address step is followed by phone prompt", async () => {
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Pancakes", price: 2500, available: true },
      ],
    },
  });

  // Step 1: customer requests menu → guided_menu
  const r1 = await service.handleInboundNormalized(msg("menu", "m1"));
  assert.equal(r1.type, "guided_menu");

  // Step 2: select item
  const r2 = await service.handleInboundNormalized(msg("Pancakes", "m2"));
  assert.equal(r2.type, "guided_quantity_prompt");

  // Step 3: quantity
  const r3 = await service.handleInboundNormalized(msg("2", "m3"));
  assert.equal(r3.type, "guided_fulfillment_prompt");

  // Step 4: choose delivery
  const r4 = await service.handleInboundNormalized(msg("delivery", "m4"));
  assert.equal(r4.type, "guided_address_prompt");

  // Step 5: provide address → should now ask for phone
  const r5 = await service.handleInboundNormalized(msg("Awoyaya, Ibeju-Lekki", "m5"));
  assert.equal(r5.type, "guided_phone_prompt", "After address, bot must ask for phone");
  assert.match(r5.replyText, /phone|rider/i, "Reply should mention phone or rider");

  // Session should be in AWAITING_DELIVERY_PHONE
  const session = getSession();
  assert.equal(session && session.state, "awaiting_delivery_phone");
  assert.ok(session && session.deliveryAddress, "Address must be saved in session");
});

test("delivery flow: phone step accepts valid phone and goes to confirmation", async () => {
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Pancakes", price: 2500, available: true },
      ],
    },
  });

  await service.handleInboundNormalized(msg("menu", "s1"));
  await service.handleInboundNormalized(msg("Pancakes", "s2"));
  await service.handleInboundNormalized(msg("1", "s3"));
  await service.handleInboundNormalized(msg("delivery", "s4"));
  await service.handleInboundNormalized(msg("5 Banana Island", "s5"));

  // Step 6: provide valid phone
  const r6 = await service.handleInboundNormalized(msg("08012345678", "s6"));
  assert.equal(r6.type, "guided_confirmation_prompt", "Valid phone should advance to confirmation");
  assert.match(r6.replyText, /YES|confirm/i);
  assert.match(r6.replyText, /08012345678/, "Confirm prompt must show the delivery phone");

  const session = getSession();
  assert.equal(session && session.state, "awaiting_confirmation");
  assert.equal(session && session.deliveryPhone, "08012345678");
});

test("delivery flow: invalid phone triggers polite retry", async () => {
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Pancakes", price: 2500, available: true },
      ],
    },
  });

  await service.handleInboundNormalized(msg("menu", "inv1"));
  await service.handleInboundNormalized(msg("Pancakes", "inv2"));
  await service.handleInboundNormalized(msg("1", "inv3"));
  await service.handleInboundNormalized(msg("delivery", "inv4"));
  await service.handleInboundNormalized(msg("5 Banana Island", "inv5"));

  // Provide obviously invalid phone
  const r6 = await service.handleInboundNormalized(msg("not a phone", "inv6"));
  assert.equal(r6.type, "guided_invalid_phone", "Invalid phone should trigger retry");
  assert.match(r6.replyText, /valid|phone|08/i);

  // Session must still be in AWAITING_DELIVERY_PHONE so user can retry
  const session = getSession();
  assert.equal(session && session.state, "awaiting_delivery_phone");
});

test("delivery flow: phone formats — +234 and spaced number are accepted", async () => {
  const { isValidDeliveryPhone } = (() => {
    // Extract the internal helper via a tiny shim
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../src/domain/services/inboundMessageService.js"),
      "utf8"
    );
    // Eval the helpers in isolation
    const fn = new Function(`
      ${src.match(/function isValidDeliveryPhone[\s\S]*?^}/m)?.[0] || "function isValidDeliveryPhone(){ return false; }"}
      return { isValidDeliveryPhone };
    `);
    return fn();
  })();

  assert.ok(isValidDeliveryPhone("08012345678"), "11-digit 080 number");
  assert.ok(isValidDeliveryPhone("+2348012345678"), "+234 format");
  assert.ok(isValidDeliveryPhone("2348012345678"), "234 without +");
  assert.ok(isValidDeliveryPhone("0812 345 6789"), "spaced format");
  assert.ok(!isValidDeliveryPhone("123"), "too short");
  assert.ok(!isValidDeliveryPhone("abcdefghijk"), "non-numeric");
});

test("pickup flow: no phone prompt", async () => {
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Pancakes", price: 2500, available: true },
      ],
    },
  });

  await service.handleInboundNormalized(msg("menu", "p1"));
  await service.handleInboundNormalized(msg("Pancakes", "p2"));
  await service.handleInboundNormalized(msg("1", "p3"));

  // Choose pickup
  const r4 = await service.handleInboundNormalized(msg("pickup", "p4"));
  assert.equal(r4.type, "guided_confirmation_prompt", "Pickup should go straight to confirmation");
  assert.doesNotMatch(r4.replyText || "", /phone|rider/i, "Pickup confirmation must NOT mention phone");

  const session = getSession();
  assert.equal(session && session.state, "awaiting_confirmation");
  // No phone step for pickup
  assert.ok(!session || !session.deliveryPhone, "deliveryPhone must not be set for pickup");
});

test("delivery flow: address + phone in one message skips phone step", async () => {
  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Pancakes", price: 2500, available: true },
      ],
    },
  });

  await service.handleInboundNormalized(msg("menu", "c1"));
  await service.handleInboundNormalized(msg("Pancakes", "c2"));
  await service.handleInboundNormalized(msg("1", "c3"));
  await service.handleInboundNormalized(msg("delivery", "c4"));

  // Provide address and phone together
  const r5 = await service.handleInboundNormalized(
    msg("5 Ikate Estate 08012345678", "c5")
  );
  assert.equal(
    r5.type,
    "guided_confirmation_prompt",
    "Combined address+phone must skip the phone step"
  );
  assert.match(r5.replyText, /08012345678/, "Confirm prompt must show the extracted phone");

  const session = getSession();
  assert.equal(session && session.state, "awaiting_confirmation");
  assert.equal(session && session.deliveryPhone, "08012345678");
});

test("delivery flow: deliveryPhone stored on order when confirmed", async () => {
  let capturedPhone = null;

  const service = buildService({
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "m1", name: "Pancakes", price: 2500, available: true },
      ],
    },
    orderService: {
      findActiveOrderByCustomer: async () => null,
      logInboundMessage: async () => ({}),
      resolveRequestedItems: async () => ({ matched: [] }),
      handleAwaitingCustomerUpdate: async () => ({ handled: false }),
      handleAwaitingCustomerEdit: async () => ({ handled: false }),
      createNewOrderFromInbound: async () => null,
      createGuidedOrder: async (params) => {
        capturedPhone = params.deliveryPhone;
        return {
          id: "ord-x",
          restaurantId: params.restaurantId,
          channel: params.channel,
          channelCustomerId: params.channelCustomerId,
          matched: [],
          fulfillmentType: params.fulfillmentType,
          deliveryAddress: params.deliveryAddress,
          deliveryPhone: params.deliveryPhone,
          total: 2500,
        };
      },
      createGuidedOrderFromItems: async (params) => {
        capturedPhone = params.deliveryPhone;
        return {
          id: "ord-x",
          restaurantId: params.restaurantId,
          channel: params.channel,
          channelCustomerId: params.channelCustomerId,
          matched: params.matched,
          fulfillmentType: params.fulfillmentType,
          deliveryAddress: params.deliveryAddress,
          deliveryPhone: params.deliveryPhone,
          total: 2500,
        };
      },
      transitionOrderStatus: async () => ({}),
      sendMessageToOrderCustomer: async () => ({}),
    },
  });

  await service.handleInboundNormalized(msg("menu", "ord1"));
  await service.handleInboundNormalized(msg("Pancakes", "ord2"));
  await service.handleInboundNormalized(msg("2", "ord3"));
  await service.handleInboundNormalized(msg("delivery", "ord4"));
  await service.handleInboundNormalized(msg("Awoyaya", "ord5"));
  await service.handleInboundNormalized(msg("08099887766", "ord6"));
  await service.handleInboundNormalized(msg("yes", "ord7"));

  assert.equal(capturedPhone, "08099887766", "deliveryPhone must be passed to createGuidedOrder");
});
