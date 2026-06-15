"use strict";

/**
 * Verifies that deterministic handlers always fire before the LLM for
 * greetings, menu requests, and acknowledgements — and that the LLM is
 * only called when no deterministic handler matches.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createInboundMessageService } = require("../src/domain/services/inboundMessageService");

function buildService({ llmClassifyCalled, llmOverride = {}, restaurantOverride = {}, configOverride = {} } = {}) {
  return createInboundMessageService({
    inboundEventRepo: { markInboundEventIfNew: async () => true },
    menuService: {
      listAvailableMenuItems: async () => [
        { id: "item-1", name: "Jollof Rice", price: 1500, available: true },
        { id: "item-2", name: "Chicken",     price: 2000, available: true },
      ],
    },
    customerService: { upsertCustomerFromChannelMessage: async () => ({ id: "cust-1" }) },
    orderService: {
      findActiveOrderByCustomer: async () => null,
      listOrders: async () => [],
      listOrderMessages: async () => ({ messages: [] }),
      getOrder: async () => { throw new Error("not found"); },
      confirmOrder: async ({ orderId }) => ({ id: orderId, status: "confirmed" }),
      rejectOrder: async ({ orderId }) => ({ id: orderId, status: "cancelled" }),
      logInboundMessage: async () => ({}),
      resolveRequestedItems: async () => ({ matched: [], invalidQuantities: [] }),
      handleAwaitingCustomerUpdate: async () => ({ handled: false }),
      handleAwaitingCustomerEdit: async () => ({ handled: false }),
      createNewOrderFromInbound: async () => null,
      transitionOrderStatus: async ({ orderId }) => ({ id: orderId, status: "cancelled" }),
      sendMessageToOrderCustomer: async () => ({}),
    },
    channelGateway: {
      normalizeInboundMessage: ({ rawEvent }) => rawEvent,
      sendMessage: async () => ({}),
    },
    conversationSessionRepo: {
      getSession: async () => null,
      upsertSession: async () => ({}),
      clearSession: async () => ({}),
    },
    restaurantRepo: {
      getRestaurantById: async () => ({
        id: "rest-1",
        name: "Test Restaurant",
        bot: { enabled: true, ...restaurantOverride },
      }),
    },
    paymentService: {
      appendCustomerPaymentReference: async () => ({ id: "order-1" }),
      markCustomerPaymentReported: async () => ({ id: "order-1", status: "payment_review" }),
    },
    llmService: {
      classifyRestaurantMessage: async () => {
        if (llmClassifyCalled) llmClassifyCalled.value = true;
        return {
          intent: "unknown",
          confidence: 0,
          replyText: "",
          shouldStartGuidedFlow: false,
          shouldHandleDirectly: false,
          suggestedAction: "",
          entities: {},
          ...llmOverride,
        };
      },
    },
    conversationMessageRepo: {
      logMessage: async () => ({}),
      listMessagesByCustomer: async () => [],
    },
    deliveryZoneRepo: { listDeliveryZones: async () => [] },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    menuCooldownMs: 0,
    ...configOverride,
  });
}

function msg(text, id = "msg-1") {
  return {
    restaurantId: "rest-1",
    message: {
      channel: "whatsapp-web",
      channelCustomerId: "2340000000001@c.us",
      customerPhone: "+2340000000001",
      text,
      providerMessageId: id,
      timestamp: Date.now(),
    },
  };
}

// ── Greeting guard ────────────────────────────────────────────────────────────

test("'hi' uses deterministic greeting — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("hi"));
  assert.equal(called.value, false, "classifyRestaurantMessage should not be called for 'hi'");
  assert.equal(result.type, "greeting");
  assert.equal(result.shouldReply, true);
});

test("'hello' uses deterministic greeting — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("hello", "msg-2"));
  assert.equal(called.value, false);
  assert.equal(result.type, "greeting");
});

test("'hello 👋' (with emoji) uses deterministic greeting — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("hello 👋", "msg-3"));
  assert.equal(called.value, false, "classifyRestaurantMessage should not be called for 'hello 👋'");
  assert.equal(result.type, "greeting");
});

test("'good morning' uses deterministic greeting — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("good morning", "msg-4"));
  assert.equal(called.value, false);
  assert.equal(result.type, "greeting");
});

test("'hey there' uses deterministic greeting — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("hey there", "msg-5"));
  assert.equal(called.value, false);
  assert.equal(result.type, "greeting");
});

// ── Custom welcome ────────────────────────────────────────────────────────────

test("custom welcome message is used for greeting when configured", async () => {
  const called = { value: false };
  const svc = buildService({
    llmClassifyCalled: called,
    restaurantOverride: { customWelcomeMessage: "Welcome to our special place! Reply MENU to order." },
  });
  const result = await svc.handleInboundNormalized(msg("hi", "msg-6"));
  assert.equal(called.value, false);
  assert.equal(result.type, "greeting");
  assert.match(result.replyText, /special place/);
});

test("default greeting is used when no custom welcome is configured", async () => {
  const svc = buildService();
  const result = await svc.handleInboundNormalized(msg("hi", "msg-7"));
  assert.equal(result.type, "greeting");
  assert.match(result.replyText, /Test Restaurant/i);
});

// ── Menu guard ────────────────────────────────────────────────────────────────

test("'menu' uses template flow — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("menu", "msg-8"));
  assert.equal(called.value, false);
  assert.equal(result.type, "guided_menu");
});

test("'can I get your menu?' uses template flow — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("can I get your menu?", "msg-9"));
  assert.equal(called.value, false);
  assert.equal(result.type, "guided_menu");
});

test("'what do you have?' uses template flow — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("what do you have?", "msg-10"));
  assert.equal(called.value, false);
  assert.equal(result.type, "guided_menu");
});

// ── Acknowledgement guard ─────────────────────────────────────────────────────

test("'ok' uses deterministic ack — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("ok", "msg-11"));
  assert.equal(called.value, false);
  assert.equal(result.type, "acknowledgement");
});

test("'thanks' uses deterministic ack — LLM not called", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  const result = await svc.handleInboundNormalized(msg("thanks", "msg-12"));
  assert.equal(called.value, false);
  assert.equal(result.type, "acknowledgement");
});

// ── LLM IS called for non-deterministic messages ──────────────────────────────

test("unknown message that isn't a greeting/menu/ack does call the LLM", async () => {
  const called = { value: false };
  const svc = buildService({ llmClassifyCalled: called });
  await svc.handleInboundNormalized(msg("I need some help please", "msg-13"));
  assert.equal(called.value, true, "classifyRestaurantMessage SHOULD be called for unknown messages");
});
