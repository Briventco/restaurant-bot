const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { buildRestaurantOrderAlertMessage } = require("../src/domain/templates/messages");

// ─── buildRestaurantOrderAlertMessage ───────────────────────────────────────

describe("buildRestaurantOrderAlertMessage — enriched fields", () => {
  const baseOrder = {
    id: "ord_abc123",
    shortCode: "ABC123",
    matched: [{ name: "Jollof Rice", price: 1200, quantity: 2, subtotal: 2400 }],
    total: 2400,
    fulfillmentType: "pickup",
    customerPhone: "08012345678",
    restaurantName: "Pepper Spot",
    orderTime: "2026-06-13T10:30:00.000Z",
  };

  it("includes restaurant name in the header", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /New Order — Pepper Spot/);
  });

  it("includes order ID", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /#ord_abc123/);
  });

  it("includes short ref code", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /Ref: ABC123/);
  });

  it("includes order time", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /Time:/);
  });

  it("includes customer phone", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /Customer: 08012345678/);
  });

  it("strips @c.us suffix from channelCustomerId", () => {
    const order = { ...baseOrder, customerPhone: "", channelCustomerId: "2348012345678@c.us" };
    const text = buildRestaurantOrderAlertMessage(order);
    assert.match(text, /Customer: 2348012345678/);
    assert.ok(!text.includes("@c.us"));
  });

  it("strips @lid suffix from channelCustomerId", () => {
    const order = { ...baseOrder, customerPhone: "", channelCustomerId: "2348012345678@lid" };
    const text = buildRestaurantOrderAlertMessage(order);
    assert.match(text, /Customer: 2348012345678/);
    assert.ok(!text.includes("@lid"));
  });

  it("omits 'New Order —' prefix and uses just 'New Order' when no restaurant name", () => {
    const order = { ...baseOrder, restaurantName: "" };
    const text = buildRestaurantOrderAlertMessage(order);
    assert.ok(text.startsWith("New Order\n"), `Expected 'New Order\\n', got: ${text.slice(0, 40)}`);
    assert.ok(!text.includes("New Order —"));
  });

  it("includes order items and total", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /Jollof Rice/);
    assert.match(text, /Total = N2400/);
  });

  it("shows delivery address and rider phone for delivery orders", () => {
    const order = {
      ...baseOrder,
      fulfillmentType: "delivery",
      deliveryAddress: "12 Main St, Lagos",
      deliveryPhone: "07011112222",
      deliveryFee: 500,
      subtotal: 2400,
      total: 2900,
    };
    const text = buildRestaurantOrderAlertMessage(order);
    assert.match(text, /Delivery: 12 Main St, Lagos/);
    assert.match(text, /Rider phone: 07011112222/);
    assert.match(text, /Delivery fee = N500/);
    assert.match(text, /Total = N2900/);
  });

  it("shows 'Pickup order' for pickup fulfillment", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /Pickup order/);
  });

  it("includes confirm/reject reply instructions", () => {
    const text = buildRestaurantOrderAlertMessage(baseOrder);
    assert.match(text, /1 - Confirm/);
    assert.match(text, /2 - Not Available/);
    assert.match(text, /#confirm ABC123/);
    assert.match(text, /#reject ABC123/);
  });
});

// ─── notifyRestaurantOrderAlert architecture ─────────────────────────────────

function buildOrderServiceDeps({
  orderAlertRecipients = [],
  centralAlertNumbers = [],
  notifyOnOrder = true,
} = {}) {
  const sentAlerts = [];
  const sessions = [];
  const logs = [];

  const restaurant = {
    id: "rest1",
    name: "Test Bistro",
    bot: { notifyOnOrder, orderAlertRecipients },
  };

  const restaurantRepo = {
    getRestaurantById: async () => restaurant,
  };

  const outboxService = {
    enqueueAndMaybeDispatch: async ({ recipient, metadata }) => {
      sentAlerts.push({ recipient, type: metadata && metadata.type });
      return { message: { id: "msg1", status: "sent" }, created: true, duplicate: false };
    },
  };

  const conversationSessionRepo = {
    upsertSession: async (restaurantId, channel, sessionRecipient, data) => {
      sessions.push({ sessionRecipient, state: data.state });
    },
  };

  const logger = {
    warn: (msg, meta) => logs.push({ msg, meta }),
  };

  return {
    sentAlerts,
    sessions,
    logs,
    restaurantRepo,
    outboxService,
    conversationSessionRepo,
    logger,
    centralAlertNumbers,
  };
}

// Import createOrderService to test the real notifyRestaurantOrderAlert
const { createOrderService } = require("../src/domain/services/orderService");

const baseOrder = {
  id: "ord_xyz",
  restaurantId: "rest1",
  channel: "whatsapp-web",
  channelCustomerId: "2348012345678@c.us",
  customerPhone: "08012345678",
  matched: [{ name: "Fried Rice", price: 1500, quantity: 1, subtotal: 1500 }],
  total: 1500,
  fulfillmentType: "pickup",
};

describe("notifyRestaurantOrderAlert — primary vs monitoring split", () => {
  it("sends alert to primary (restaurant) recipient", async () => {
    const deps = buildOrderServiceDeps({
      orderAlertRecipients: ["08099990001"],
      centralAlertNumbers: [],
    });

    const svc = createOrderService({
      restaurantRepo: deps.restaurantRepo,
      outboxService: deps.outboxService,
      conversationSessionRepo: deps.conversationSessionRepo,
      logger: deps.logger,
      centralAlertNumbers: deps.centralAlertNumbers,
      orderRepo: { createOrder: async () => ({}), addStatusHistory: async () => {} },
      menuRepo: { listMenuItems: async () => [] },
      orderParsingService: { parseOrder: async () => [] },
    });

    // Access via internal trigger — call notifyRestaurantOrderAlert through createGuidedOrder
    // Instead, we test at the outbox level by inspecting sentAlerts
    // We inline-call the function via order service internals
    // Use a small helper to expose it for testing
    await svc.sendRestaurantAlertMessage({
      order: baseOrder,
      recipient: "08099990001",
      text: "test",
      metadata: { type: "restaurant_order_alert" },
    });

    assert.equal(deps.sentAlerts.length, 1);
    assert.equal(deps.sentAlerts[0].recipient, "08099990001");
  });

  it("sends alert to primary recipients and monitoring copy to central (non-overlapping)", async () => {
    const allSent = [];

    const restaurant = {
      name: "Spice Hub",
      bot: { notifyOnOrder: true, orderAlertRecipients: ["0801AAAA001"] },
    };

    const restaurantRepo = { getRestaurantById: async () => restaurant };
    const outboxService = {
      enqueueAndMaybeDispatch: async ({ recipient, metadata }) => {
        allSent.push({ recipient, type: metadata && metadata.type });
        return { message: { id: "m1", status: "sent" }, created: true, duplicate: false };
      },
    };
    const conversationSessionRepo = {
      upsertSession: async () => {},
    };

    const svc = createOrderService({
      restaurantRepo,
      outboxService,
      conversationSessionRepo,
      logger: { warn: () => {} },
      centralAlertNumbers: ["09130123219"],
      orderRepo: { createOrder: async () => ({}), addStatusHistory: async () => {} },
      menuRepo: { listMenuItems: async () => [] },
      orderParsingService: { parseOrder: async () => [] },
    });

    // Trigger notifyRestaurantOrderAlert via createGuidedOrder internals
    // We do this by stubbing createOrder to return a valid order then calling createGuidedOrder
    // For a simpler test, directly call the exposed sendRestaurantTestAlert path OR
    // use createGuidedOrder with a real menu item.
    // Actually the cleanest way: patch orderRepo.createOrder to return baseOrder, then call createGuidedOrder
    const patchedSvc = createOrderService({
      restaurantRepo,
      outboxService,
      conversationSessionRepo,
      logger: { warn: () => {} },
      centralAlertNumbers: ["09130123219"],
      orderRepo: {
        createOrder: async () => ({ ...baseOrder, id: "ord_test" }),
        addStatusHistory: async () => {},
      },
      menuRepo: { listMenuItems: async () => [] },
      orderParsingService: { parseOrder: async () => [] },
    });

    await patchedSvc.createGuidedOrder({
      restaurantId: "rest1",
      customer: { id: "cust1" },
      channel: "whatsapp-web",
      channelCustomerId: "2348012345678@c.us",
      customerPhone: "08012345678",
      menuItem: { id: "m1", name: "Suya", price: 800 },
      quantity: 1,
      fulfillmentType: "pickup",
    });

    const primaryAlerts = allSent.filter((s) => s.type === "restaurant_order_alert");
    const monitorAlerts = allSent.filter((s) => s.type === "restaurant_order_alert_monitoring");

    assert.equal(primaryAlerts.length, 1, "exactly one primary alert sent");
    assert.equal(primaryAlerts[0].recipient, "0801AAAA001");

    assert.equal(monitorAlerts.length, 1, "exactly one monitoring alert sent");
    assert.equal(monitorAlerts[0].recipient, "09130123219");
  });

  it("does not send monitoring copy when central number is already a primary recipient", async () => {
    const allSent = [];

    const restaurant = {
      name: "Overlap Cafe",
      // The restaurant admin explicitly added the central number to their alert list
      bot: { notifyOnOrder: true, orderAlertRecipients: ["09130123219"] },
    };

    const restaurantRepo = { getRestaurantById: async () => restaurant };
    const outboxService = {
      enqueueAndMaybeDispatch: async ({ recipient, metadata }) => {
        allSent.push({ recipient, type: metadata && metadata.type });
        return { message: { id: "m1", status: "sent" }, created: true, duplicate: false };
      },
    };

    const svc = createOrderService({
      restaurantRepo,
      outboxService,
      conversationSessionRepo: { upsertSession: async () => {} },
      logger: { warn: () => {} },
      centralAlertNumbers: ["09130123219"],
      orderRepo: {
        createOrder: async () => ({ ...baseOrder }),
        addStatusHistory: async () => {},
      },
      menuRepo: { listMenuItems: async () => [] },
      orderParsingService: { parseOrder: async () => [] },
    });

    await svc.createGuidedOrder({
      restaurantId: "rest1",
      customer: { id: "c1" },
      channel: "whatsapp-web",
      channelCustomerId: "234@c.us",
      customerPhone: "09000000001",
      menuItem: { id: "m1", name: "Wrap", price: 600 },
      quantity: 1,
      fulfillmentType: "pickup",
    });

    // The central number should appear exactly once (as primary), not twice
    const toCenter = allSent.filter((s) => s.recipient === "09130123219");
    assert.equal(toCenter.length, 1, "central number receives exactly one alert (no duplicate monitoring copy)");
    assert.equal(toCenter[0].type, "restaurant_order_alert");
  });

  it("logs warning but does not crash when no primary recipients configured", async () => {
    const logs = [];
    const allSent = [];

    const restaurant = {
      name: "Silent Kitchen",
      bot: { notifyOnOrder: true, orderAlertRecipients: [] },
    };

    const restaurantRepo = { getRestaurantById: async () => restaurant };
    const outboxService = {
      enqueueAndMaybeDispatch: async ({ recipient, metadata }) => {
        allSent.push({ recipient, type: metadata && metadata.type });
        return { message: { id: "m1", status: "sent" }, created: true, duplicate: false };
      },
    };

    const svc = createOrderService({
      restaurantRepo,
      outboxService,
      conversationSessionRepo: { upsertSession: async () => {} },
      logger: { warn: (msg, meta) => logs.push({ msg, meta }) },
      centralAlertNumbers: ["09130123219"],
      orderRepo: {
        createOrder: async () => ({ ...baseOrder }),
        addStatusHistory: async () => {},
      },
      menuRepo: { listMenuItems: async () => [] },
      orderParsingService: { parseOrder: async () => [] },
    });

    // Should not throw
    await assert.doesNotReject(() =>
      svc.createGuidedOrder({
        restaurantId: "rest1",
        customer: { id: "c1" },
        channel: "whatsapp-web",
        channelCustomerId: "234@c.us",
        customerPhone: "09000000001",
        menuItem: { id: "m1", name: "Wrap", price: 600 },
        quantity: 1,
        fulfillmentType: "pickup",
      })
    );

    // Warning logged about no recipients
    const noRecipientWarning = logs.find((l) => /no alert recipients/i.test(l.msg));
    assert.ok(noRecipientWarning, "should log a warning when no primary recipients");

    // Monitoring copy still sent to central
    assert.equal(allSent.filter((s) => s.recipient === "09130123219").length, 1);
  });

  it("does not crash when a primary alert fails — continues to next recipient", async () => {
    const logs = [];
    const succeeded = [];
    let callCount = 0;

    const restaurant = {
      name: "Partial Cafe",
      bot: { notifyOnOrder: true, orderAlertRecipients: ["0801BAD0001", "0801GOOD001"] },
    };

    const restaurantRepo = { getRestaurantById: async () => restaurant };
    const outboxService = {
      enqueueAndMaybeDispatch: async ({ recipient }) => {
        callCount++;
        if (recipient === "0801BAD0001") {
          throw new Error("Network error");
        }
        succeeded.push(recipient);
        return { message: { id: "m1", status: "sent" }, created: true, duplicate: false };
      },
    };

    const svc = createOrderService({
      restaurantRepo,
      outboxService,
      conversationSessionRepo: { upsertSession: async () => {} },
      logger: { warn: (msg, meta) => logs.push({ msg, meta }) },
      centralAlertNumbers: [],
      orderRepo: {
        createOrder: async () => ({ ...baseOrder }),
        addStatusHistory: async () => {},
      },
      menuRepo: { listMenuItems: async () => [] },
      orderParsingService: { parseOrder: async () => [] },
    });

    await assert.doesNotReject(() =>
      svc.createGuidedOrder({
        restaurantId: "rest1",
        customer: { id: "c1" },
        channel: "whatsapp-web",
        channelCustomerId: "234@c.us",
        customerPhone: "09000000001",
        menuItem: { id: "m1", name: "Wrap", price: 600 },
        quantity: 1,
        fulfillmentType: "pickup",
      })
    );

    // The good recipient still received its alert
    assert.ok(succeeded.includes("0801GOOD001"), "good recipient should still receive alert");

    // Failure was logged
    const failLog = logs.find((l) => /failed to alert primary/i.test(l.msg));
    assert.ok(failLog, "should log the failed primary alert");
  });

  it("does not set staff action session for monitoring (central) recipients", async () => {
    const sessions = [];
    const allSent = [];

    const restaurant = {
      name: "Jollof Spot",
      bot: { notifyOnOrder: true, orderAlertRecipients: ["0801OWNER001"] },
    };

    const restaurantRepo = { getRestaurantById: async () => restaurant };
    const outboxService = {
      enqueueAndMaybeDispatch: async ({ recipient, metadata }) => {
        allSent.push({ recipient, type: metadata && metadata.type });
        return { message: { id: "m1", status: "sent" }, created: true, duplicate: false };
      },
    };
    const conversationSessionRepo = {
      upsertSession: async (restaurantId, channel, sessionRecipient, data) => {
        sessions.push({ sessionRecipient, state: data.state });
      },
    };

    const svc = createOrderService({
      restaurantRepo,
      outboxService,
      conversationSessionRepo,
      logger: { warn: () => {} },
      centralAlertNumbers: ["09130123219"],
      orderRepo: {
        createOrder: async () => ({ ...baseOrder }),
        addStatusHistory: async () => {},
      },
      menuRepo: { listMenuItems: async () => [] },
      orderParsingService: { parseOrder: async () => [] },
    });

    await svc.createGuidedOrder({
      restaurantId: "rest1",
      customer: { id: "c1" },
      channel: "whatsapp-web",
      channelCustomerId: "234@c.us",
      customerPhone: "09000000001",
      menuItem: { id: "m1", name: "Jollof", price: 1200 },
      quantity: 1,
      fulfillmentType: "pickup",
    });

    // Staff action sessions should only be for the primary owner number, not for 09130123219
    const staffSessions = sessions.filter((s) => s.state === "awaiting_staff_order_action");
    const hasOwnerSession = staffSessions.some((s) => s.sessionRecipient.includes("0801OWNER001") || s.sessionRecipient.includes("234080100100001"));
    const hasCentralSession = staffSessions.some((s) =>
      s.sessionRecipient.includes("09130123219") || s.sessionRecipient.includes("2349130123219")
    );

    // The central monitoring number must NOT have a staff action session
    assert.ok(!hasCentralSession, "central monitoring number must not get a staff action session");
  });
});
