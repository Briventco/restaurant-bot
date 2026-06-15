"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildRestaurantOrderAlertMessage } = require("../src/domain/templates/messages");
const { createOrderService } = require("../src/domain/services/orderService");

describe("buildRestaurantOrderAlertMessage", () => {
  const baseOrder = {
    id: "ord_abc123",
    shortCode: "ABC123",
    matched: [{ name: "Jollof Rice", price: 1200, quantity: 2, subtotal: 2400 }],
    total: 2400,
    fulfillmentType: "pickup",
    customerName: "Amara",
    customerPhone: "08012345678",
    restaurantName: "Pepper Spot",
    orderTime: "2026-06-13T10:30:00.000Z",
  };

  it("includes restaurant, order reference, customer name, customer phone, and instructions", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /New Order — Pepper Spot/);
    assert.match(text, /#ord_abc123/);
    assert.match(text, /Ref: ABC123/);
    assert.match(text, /Customer name: Amara/);
    assert.match(text, /Customer phone: 08012345678/);
    assert.match(text, /1 - Confirm/);
    assert.match(text, /#confirm ABC123/);
  });

  it("shows delivery details when fulfillment is delivery", () => {
    const text = buildRestaurantOrderAlertMessage({
      ...baseOrder,
      fulfillmentType: "delivery",
      deliveryAddress: "12 Main St, Lagos",
      deliveryPhone: "07011112222",
      deliveryFee: 500,
      subtotal: 2400,
      total: 2900,
    });

    assert.match(text, /Delivery: 12 Main St, Lagos/);
    assert.match(text, /Rider phone: 07011112222/);
    assert.match(text, /Delivery fee = N500/);
    assert.match(text, /Total = N2900/);
  });
});

function buildOrderServiceDeps({
  restaurantPhone = "",
  orderAlertRecipients = [],
  notifyOnOrder = true,
  outboxImpl = null,
} = {}) {
  const sentAlerts = [];
  const sessions = [];
  const orderMessages = [];
  const logs = {
    info: [],
    warn: [],
    error: [],
  };
  let createdOrderSeq = 0;

  const restaurants = new Map([
    [
      "rest1",
      {
        id: "rest1",
        restaurantId: "rest1",
        name: "Test Bistro",
        phone: restaurantPhone,
        bot: {
          notifyOnOrder,
          orderAlertRecipients,
        },
      },
    ],
    [
      "tacos_joint",
      {
        id: "tacos_joint",
        restaurantId: "tacos_joint",
        name: "Taco Joint",
        phone: "08055550001",
        bot: {
          notifyOnOrder: true,
          orderAlertRecipients: ["08055550001"],
        },
      },
    ],
  ]);

  const restaurantRepo = {
    getRestaurantById: async (restaurantId) =>
      restaurants.get(String(restaurantId || "").trim()) || null,
  };

  const outboxService = {
    enqueueAndMaybeDispatch: async (payload) => {
      sentAlerts.push(JSON.parse(JSON.stringify(payload)));
      if (typeof outboxImpl === "function") {
        return outboxImpl(payload);
      }
      return {
        message: {
          id: `outbox-${sentAlerts.length}`,
          status: "sent",
          attemptCount: 1,
        },
        created: true,
        duplicate: false,
      };
    },
  };

  const conversationSessionRepo = {
    upsertSession: async (restaurantId, channel, sessionRecipient, data) => {
      sessions.push({ restaurantId, channel, sessionRecipient, data });
    },
  };

  const orderRepo = {
    createOrder: async (restaurantId, payload) => {
      createdOrderSeq += 1;
      return {
        id: `ord-${createdOrderSeq}`,
        createdAt: "2026-06-13T10:30:00.000Z",
        ...payload,
        restaurantId,
      };
    },
    addStatusHistory: async () => ({}),
    addOrderMessage: async (_restaurantId, orderId, payload) => {
      orderMessages.push({ orderId, ...JSON.parse(JSON.stringify(payload)) });
      return payload;
    },
    getOrderById: async () => null,
    listOrders: async () => [],
  };

  const logger = {
    info: (message, meta) => logs.info.push({ message, meta }),
    warn: (message, meta) => logs.warn.push({ message, meta }),
    error: (message, meta) => logs.error.push({ message, meta }),
  };

  const orderService = createOrderService({
    restaurantRepo,
    outboxService,
    conversationSessionRepo,
    logger,
    orderRepo,
    menuRepo: { listMenuItems: async () => [] },
    orderParsingService: { parseOrder: async () => [] },
  });

  return { orderService, sentAlerts, sessions, orderMessages, logs };
}

async function placeOrder(orderService, restaurantId = "rest1") {
  return orderService.createGuidedOrder({
    restaurantId,
    customer: { id: "cust-1", displayName: "Ada" },
    channel: "whatsapp-web",
    channelCustomerId: "2348012345678@c.us",
    customerPhone: "08012345678",
    menuItem: { id: "m1", name: "Suya", price: 800 },
    quantity: 1,
    fulfillmentType: "pickup",
  });
}

describe("restaurant order alert direction", () => {
  it("sends alert to bot.orderAlertRecipients when configured", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "08099990000",
      orderAlertRecipients: ["08099990001"],
    });

    await placeOrder(deps.orderService);

    assert.equal(deps.sentAlerts.length, 1);
    assert.equal(deps.sentAlerts[0].recipient, "08099990001");
    // alert is sent through the restaurant's own session, never a sender override
    assert.equal(deps.sentAlerts[0].restaurantId, "rest1");
    // no senderRestaurantId override in metadata
    assert.ok(
      !deps.sentAlerts[0].metadata.senderRestaurantId,
      "senderRestaurantId must not be injected into metadata"
    );
  });

  it("falls back to restaurant.phone when orderAlertRecipients is empty", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "08099990002",
      orderAlertRecipients: [],
    });

    await placeOrder(deps.orderService);

    assert.equal(deps.sentAlerts.length, 1);
    assert.equal(deps.sentAlerts[0].recipient, "08099990002");
    assert.equal(deps.sentAlerts[0].restaurantId, "rest1");
  });

  it("routes each restaurant's alert through its own session independently", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "08055550001",
      orderAlertRecipients: ["08055550001"],
    });

    // Order for rest1
    await placeOrder(deps.orderService, "rest1");
    // Order for tacos_joint
    await placeOrder(deps.orderService, "tacos_joint");

    assert.equal(deps.sentAlerts.length, 2);
    assert.equal(deps.sentAlerts[0].restaurantId, "rest1");
    assert.equal(deps.sentAlerts[1].restaurantId, "tacos_joint");
    assert.equal(deps.sentAlerts[0].recipient, "08055550001");
    assert.equal(deps.sentAlerts[1].recipient, "08055550001");
  });

  it("creates a staff action session for the alert recipient", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "08099990001",
      orderAlertRecipients: ["08099990001"],
    });

    await placeOrder(deps.orderService);

    const sessionRecipients = deps.sessions.map((s) => s.sessionRecipient);
    assert.ok(
      sessionRecipients.some((r) => r.includes("08099990001")),
      "alert recipient should get a staff action session"
    );
  });

  it("logs a clear error and keeps order creation alive when no recipients are configured", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "",
      orderAlertRecipients: [],
    });

    await assert.doesNotReject(() => placeOrder(deps.orderService));

    assert.equal(deps.sentAlerts.length, 0);
    assert.ok(
      deps.logs.error.some((entry) =>
        /no alert recipients configured/i.test(entry.message)
      ),
      "missing recipients should be logged as an error"
    );
  });

  it("logs a clear warning and keeps order creation alive when alert delivery fails", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "08099990001",
      orderAlertRecipients: ["08099990001"],
      outboxImpl: async () => {
        throw new Error("transport_down");
      },
    });

    await assert.doesNotReject(() => placeOrder(deps.orderService));

    assert.ok(
      deps.logs.warn.some((entry) =>
        /failed to send alert to recipient/i.test(entry.message)
      ),
      "failed alert delivery should be logged as a warning"
    );
  });
});
