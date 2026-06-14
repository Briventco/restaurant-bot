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
  senderRestaurantId = "servra-hq",
  senderNumber = "09130123219",
  resolveSenderByPhone = false,
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
      "servra-hq",
      {
        id: "servra-hq",
        restaurantId: "servra-hq",
        name: "Servra Alerts",
        whatsapp: {
          phone: senderNumber,
        },
      },
    ],
  ]);

  const restaurantRepo = {
    getRestaurantById: async (restaurantId) =>
      restaurants.get(String(restaurantId || "").trim()) || null,
    findRestaurantByWhatsappBinding: async ({ phone }) => {
      if (!resolveSenderByPhone) {
        return null;
      }

      const normalizedPhone = String(phone || "").replace(/[^0-9]/g, "");
      const senderDigits = String(senderNumber || "").replace(/[^0-9]/g, "");
      return normalizedPhone === senderDigits ? restaurants.get("servra-hq") : null;
    },
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
      sessions.push({
        restaurantId,
        channel,
        sessionRecipient,
        data,
      });
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
      orderMessages.push({
        orderId,
        ...JSON.parse(JSON.stringify(payload)),
      });
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
    alertSenderNumber: senderNumber,
    alertSenderRestaurantId: resolveSenderByPhone ? "" : senderRestaurantId,
    orderRepo,
    menuRepo: { listMenuItems: async () => [] },
    orderParsingService: { parseOrder: async () => [] },
  });

  return {
    orderService,
    sentAlerts,
    sessions,
    orderMessages,
    logs,
  };
}

describe("restaurant order alert direction", () => {
  it("sends the new order alert to the restaurant profile phone and marks Servra as the sender", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "08099990001",
      orderAlertRecipients: ["08000000000"],
      senderRestaurantId: "servra-hq",
      senderNumber: "09130123219",
    });

    await deps.orderService.createGuidedOrder({
      restaurantId: "rest1",
      customer: {
        id: "cust-1",
        displayName: "Ada",
      },
      channel: "whatsapp-web",
      channelCustomerId: "2348012345678@c.us",
      customerPhone: "08012345678",
      menuItem: { id: "m1", name: "Suya", price: 800 },
      quantity: 1,
      fulfillmentType: "pickup",
    });

    assert.equal(deps.sentAlerts.length, 1);
    assert.equal(deps.sentAlerts[0].recipient, "08099990001");
    assert.equal(
      deps.sentAlerts[0].metadata.senderRestaurantId,
      "servra-hq"
    );
    assert.equal(deps.sentAlerts[0].metadata.senderNumber, "09130123219");
    assert.ok(
      !deps.sentAlerts.some((payload) => payload.recipient === "08000000000"),
      "legacy settings-based alert numbers must not drive order alert delivery"
    );
    assert.ok(
      !deps.sentAlerts.some((payload) => payload.recipient === "09130123219"),
      "Servra default number must not be used as the alert recipient"
    );

    const sessionRecipients = deps.sessions.map((session) => session.sessionRecipient);
    assert.ok(
      sessionRecipients.some((recipient) => recipient.includes("08099990001")),
      "restaurant recipient should get a staff action session"
    );
    assert.ok(
      !sessionRecipients.some((recipient) => recipient.includes("09130123219")),
      "Servra sender number must not get a staff action session"
    );

    const storedAlertMessage = deps.orderMessages.find(
      (message) => message.metadata && message.metadata.internalAlert === true
    );
    assert.ok(storedAlertMessage, "alert should be recorded on the order");
    assert.equal(storedAlertMessage.metadata.alertRecipient, "08099990001");
    assert.equal(storedAlertMessage.metadata.senderNumber, "09130123219");
  });

  it("can resolve the Servra sender tenant from the configured sender phone number", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "08099990002",
      senderNumber: "09130123219",
      resolveSenderByPhone: true,
    });

    await deps.orderService.createGuidedOrder({
      restaurantId: "rest1",
      customer: {
        id: "cust-1",
        displayName: "Tunde",
      },
      channel: "whatsapp-web",
      channelCustomerId: "2348012345678@c.us",
      customerPhone: "08012345678",
      menuItem: { id: "m1", name: "Rice", price: 1200 },
      quantity: 1,
      fulfillmentType: "pickup",
    });

    assert.equal(deps.sentAlerts.length, 1);
    assert.equal(
      deps.sentAlerts[0].metadata.senderRestaurantId,
      "servra-hq"
    );
    assert.equal(deps.sentAlerts[0].metadata.senderNumber, "09130123219");
  });

  it("logs a clear error and keeps order creation alive when the restaurant profile phone is missing", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "",
      orderAlertRecipients: ["08099990003"],
      senderRestaurantId: "servra-hq",
    });

    await assert.doesNotReject(() =>
      deps.orderService.createGuidedOrder({
        restaurantId: "rest1",
        customer: {
          id: "cust-1",
          displayName: "Kemi",
        },
        channel: "whatsapp-web",
        channelCustomerId: "2348012345678@c.us",
        customerPhone: "08012345678",
        menuItem: { id: "m1", name: "Wrap", price: 600 },
        quantity: 1,
        fulfillmentType: "pickup",
      })
    );

    assert.equal(deps.sentAlerts.length, 0);
    assert.ok(
      deps.logs.error.some((entry) =>
        /restaurant profile phone is missing/i.test(entry.message)
      ),
      "missing restaurant profile phone should be logged clearly"
    );
  });

  it("logs a clear warning and keeps order creation alive when alert delivery to the profile phone fails", async () => {
    const deps = buildOrderServiceDeps({
      restaurantPhone: "0801GOOD001",
      orderAlertRecipients: ["0801BAD0001"],
      senderRestaurantId: "servra-hq",
      outboxImpl: async (payload) => {
        throw new Error(`transport_down:${payload.recipient}`);
      },
    });

    await assert.doesNotReject(() =>
      deps.orderService.createGuidedOrder({
        restaurantId: "rest1",
        customer: {
          id: "cust-1",
          displayName: "Bola",
        },
        channel: "whatsapp-web",
        channelCustomerId: "2348012345678@c.us",
        customerPhone: "08012345678",
        menuItem: { id: "m1", name: "Beans", price: 900 },
        quantity: 1,
        fulfillmentType: "pickup",
      })
    );

    assert.equal(deps.sentAlerts.length, 1);
    assert.equal(deps.sentAlerts[0].recipient, "0801GOOD001");
    assert.ok(
      deps.logs.warn.some((entry) =>
        /failed to send alert to restaurant recipient/i.test(entry.message)
      ),
      "failed restaurant alert delivery should be logged"
    );
  });
});
