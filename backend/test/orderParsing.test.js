const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createOrderParsingService,
  parseWithRegex,
} = require("../src/domain/services/orderParsingService");

test("parseWithRegex extracts quantities and default quantity", () => {
  const items = parseWithRegex("2 jollof rice and chicken", [
    { name: "jollof rice", price: 1500, available: true },
    { name: "chicken", price: 1000, available: true },
  ]);

  assert.deepEqual(items, [
    { name: "jollof rice", quantity: 2 },
    { name: "chicken", quantity: 1 },
  ]);
});

test("parseWithRegex preserves mixed per-item quantities", () => {
  const items = parseWithRegex(
    "Yes, 2 portions of jollof rice, 1 chicken, two water and one Chapman",
    [
      { name: "Jollof Rice", price: 1500, available: true },
      { name: "Chicken", price: 1000, available: true },
      { name: "Water", price: 500, available: true },
      { name: "Chapman", price: 1200, available: true },
    ]
  );

  assert.deepEqual(items, [
    { name: "Jollof Rice", quantity: 2 },
    { name: "Chicken", quantity: 1 },
    { name: "Water", quantity: 2 },
    { name: "Chapman", quantity: 1 },
  ]);
});

test("interpretCustomerMessage returns Servra-style structured order details", async () => {
  const service = createOrderParsingService({
    logger: {
      warn: () => {},
    },
  });

  const interpretation = await service.interpretCustomerMessage(
    "abeg 2 jollof rice and 1 chicken delivery to 12 Allen Avenue",
    [
      { name: "jollof rice", price: 1500, available: true },
      { name: "chicken", price: 1000, available: true },
    ]
  );

  assert.deepEqual(interpretation, {
    intent: "place_order",
    items: [
      { name: "jollof rice", quantity: 2 },
      { name: "chicken", quantity: 1 },
    ],
    quantity: 3,
    deliveryOrPickup: "delivery",
    address: "12 Allen Avenue",
    paymentIntent: "not_specified",
    clarificationNeeded: false,
  });
});

test("interpretCustomerMessage keeps per-item quantities and only sums top-level quantity", async () => {
  const service = createOrderParsingService({
    logger: {
      warn: () => {},
    },
  });

  const interpretation = await service.interpretCustomerMessage(
    "Yes, 2 portions of Jollof Rice, 1 Chicken, two Water and one Chapman",
    [
      { name: "Jollof Rice", price: 1500, available: true },
      { name: "Chicken", price: 1000, available: true },
      { name: "Water", price: 500, available: true },
      { name: "Chapman", price: 1200, available: true },
    ]
  );

  assert.deepEqual(interpretation, {
    intent: "place_order",
    items: [
      { name: "Jollof Rice", quantity: 2 },
      { name: "Chicken", quantity: 1 },
      { name: "Water", quantity: 2 },
      { name: "Chapman", quantity: 1 },
    ],
    quantity: 6,
    deliveryOrPickup: "",
    address: "",
    paymentIntent: "not_specified",
    clarificationNeeded: true,
  });
});

test("interpretCustomerMessage flags missing fulfillment details for an order", async () => {
  const service = createOrderParsingService({
    logger: {
      warn: () => {},
    },
  });

  const interpretation = await service.interpretCustomerMessage("2 jollof rice", [
    { name: "jollof rice", price: 1500, available: true },
  ]);

  assert.deepEqual(interpretation, {
    intent: "place_order",
    items: [{ name: "jollof rice", quantity: 2 }],
    quantity: 2,
    deliveryOrPickup: "",
    address: "",
    paymentIntent: "not_specified",
    clarificationNeeded: true,
  });
});

test("interpretCustomerMessage recognizes payment updates", async () => {
  const service = createOrderParsingService({
    logger: {
      warn: () => {},
    },
  });

  const interpretation = await service.interpretCustomerMessage(
    "I have paid. Transfer made with ref 9981",
    [{ name: "jollof rice", price: 1500, available: true }]
  );

  assert.deepEqual(interpretation, {
    intent: "payment_update",
    items: [],
    quantity: 0,
    deliveryOrPickup: "",
    address: "",
    paymentIntent: "payment_sent",
    clarificationNeeded: false,
  });
});

test("interpretCustomerMessage does not invent menu items", async () => {
  const service = createOrderParsingService({
    logger: {
      warn: () => {},
    },
  });

  const interpretation = await service.interpretCustomerMessage("please 2 sushi", [
    { name: "jollof rice", price: 1500, available: true },
  ]);

  assert.deepEqual(interpretation, {
    intent: "place_order",
    items: [],
    quantity: 0,
    deliveryOrPickup: "",
    address: "",
    paymentIntent: "not_specified",
    clarificationNeeded: true,
  });
});

test("interpretCustomerMessage does not treat generic help text as an order", async () => {
  const service = createOrderParsingService({
    logger: {
      warn: () => {},
    },
  });

  const interpretation = await service.interpretCustomerMessage("please help me", [
    { name: "jollof rice", price: 1500, available: true },
  ]);

  assert.deepEqual(interpretation, {
    intent: "support",
    items: [],
    quantity: 0,
    deliveryOrPickup: "",
    address: "",
    paymentIntent: "not_specified",
    clarificationNeeded: false,
  });
});

test("interpretCustomerMessage requires clarification when menu is missing", async () => {
  const service = createOrderParsingService({
    logger: {
      warn: () => {},
    },
  });

  const interpretation = await service.interpretCustomerMessage("2 jollof rice pickup", []);

  assert.deepEqual(interpretation, {
    intent: "place_order",
    items: [],
    quantity: 0,
    deliveryOrPickup: "pickup",
    address: "",
    paymentIntent: "not_specified",
    clarificationNeeded: true,
  });
});
