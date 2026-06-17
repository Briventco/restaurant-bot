const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { applyWelcomePlaceholders } = require("../src/domain/templates/messages");

// Minimal stubs for inboundMessageService greeting handler tests
function buildGreetingTestDeps({
  customWelcomeMessage = "",
  restaurantName = "Test Eats",
  displayName = "",
  savedCustomerDisplayName = "",
  menuItems = [],
} = {}) {
  const sent = [];
  const restaurant = {
    name: restaurantName,
    bot: customWelcomeMessage ? { customWelcomeMessage } : {},
  };

  const sendMessage = async (_to, text) => { sent.push(text); };

  const customerService = {
    getCustomerByPhone: async () =>
      savedCustomerDisplayName ? { displayName: savedCustomerDisplayName } : null,
  };

  return { sent, restaurant, sendMessage, menuItems, displayName, customerService };
}

// Inline reimplementation of just the greeting branch logic (mirrors inboundMessageService.js)
async function runGreetingBranch({
  restaurant,
  menuItems,
  displayName,
  customerService,
  sendMessage,
}) {
  const bot =
    restaurant && restaurant.bot && typeof restaurant.bot === "object"
      ? restaurant.bot
      : {};
  const restaurantName =
    String((restaurant && restaurant.name) || "").trim() || "our restaurant";
  const liveName = String(displayName || "").trim();
  const savedCustomer = customerService && typeof customerService.getCustomerByPhone === "function"
    ? await customerService.getCustomerByPhone({})
    : null;
  const customerName = liveName || String((savedCustomer && savedCustomer.displayName) || "").trim();

  let replyText;
  if (bot.customWelcomeMessage && String(bot.customWelcomeMessage).trim()) {
    replyText = applyWelcomePlaceholders(String(bot.customWelcomeMessage).trim(), {
      restaurantName,
      customerName,
    });
  } else {
    const availableItems = (menuItems || []).filter((item) => item.available);
    const sample = availableItems.slice(0, 3).map((item) => item.name).join(", ");
    replyText = sample
      ? `Hi there. You're welcome at ${restaurantName}.\n\nToday we have ${sample}. Reply MENU to see everything.`
      : `Hi there. You're welcome at ${restaurantName}.\n\nReply MENU to see what is available today.`;
  }

  await sendMessage("recipient", replyText);
  return replyText;
}

describe("applyWelcomePlaceholders", () => {
  it("replaces {restaurant_name} placeholder", () => {
    const result = applyWelcomePlaceholders(
      "Welcome to {restaurant_name}! Come order.",
      { restaurantName: "Suya Palace", customerName: "" }
    );
    assert.equal(result, "Welcome to Suya Palace! Come order.");
  });

  it("replaces {customer_name} placeholder", () => {
    const result = applyWelcomePlaceholders(
      "Hi {customer_name}, welcome!",
      { restaurantName: "", customerName: "Amara" }
    );
    assert.equal(result, "Hi Amara, welcome!");
  });

  it("replaces both placeholders together", () => {
    const result = applyWelcomePlaceholders(
      "Hi {customer_name}, welcome to {restaurant_name}!",
      { restaurantName: "Pepper Spot", customerName: "Tunde" }
    );
    assert.equal(result, "Hi Tunde, welcome to Pepper Spot!");
  });

  it("is case-insensitive for placeholder names", () => {
    const result = applyWelcomePlaceholders(
      "Hi {CUSTOMER_NAME} at {RESTAURANT_NAME}",
      { restaurantName: "Buka", customerName: "Ada" }
    );
    assert.equal(result, "Hi Ada at Buka");
  });

  it("uses fallback 'our restaurant' when restaurantName is empty", () => {
    const result = applyWelcomePlaceholders(
      "Welcome to {restaurant_name}!",
      { restaurantName: "", customerName: "" }
    );
    assert.equal(result, "Welcome to our restaurant!");
  });

  it("uses fallback 'there' when customerName is empty", () => {
    const result = applyWelcomePlaceholders(
      "Hi {customer_name}!",
      { restaurantName: "", customerName: "" }
    );
    assert.equal(result, "Hi there!");
  });

  it("returns template unchanged when no placeholders present", () => {
    const template = "Welcome! Tap MENU to see what we have today.";
    assert.equal(applyWelcomePlaceholders(template, { restaurantName: "X", customerName: "Y" }), template);
  });

  it("handles empty template string", () => {
    assert.equal(applyWelcomePlaceholders("", { restaurantName: "X", customerName: "Y" }), "");
  });
});

describe("greeting handler — custom welcome message", () => {
  it("uses custom welcome message when set on restaurant", async () => {
    const { sent, restaurant, sendMessage, menuItems, displayName } = buildGreetingTestDeps({
      customWelcomeMessage: "Hey! Welcome to {restaurant_name}. Reply MENU to order.",
      restaurantName: "Suya Palace",
      displayName: "",
      menuItems: [{ name: "Suya", price: 1500, available: true }],
    });

    const reply = await runGreetingBranch({ restaurant, menuItems, displayName, sendMessage });

    assert.equal(sent.length, 1);
    assert.match(reply, /Welcome to Suya Palace/);
    assert.match(reply, /Reply MENU to order/);
  });

  it("substitutes customer name placeholder when displayName is available", async () => {
    const { sent, restaurant, sendMessage, menuItems } = buildGreetingTestDeps({
      customWelcomeMessage: "Hi {customer_name}! Welcome to {restaurant_name}.",
      restaurantName: "Chops HQ",
      displayName: "",
      menuItems: [],
    });

    const reply = await runGreetingBranch({
      restaurant,
      menuItems,
      displayName: "Ngozi",
      sendMessage,
    });

    assert.equal(sent.length, 1);
    assert.match(reply, /Hi Ngozi/);
    assert.match(reply, /Welcome to Chops HQ/);
  });

  it("falls back to saved customer display name when live displayName is missing", async () => {
    const { sent, restaurant, sendMessage, menuItems, customerService } = buildGreetingTestDeps({
      customWelcomeMessage: "Hi {customer_name}! Welcome to {restaurant_name}.",
      restaurantName: "Mama's Spot",
      displayName: "",
      savedCustomerDisplayName: "Bola",
      menuItems: [],
    });

    const reply = await runGreetingBranch({
      restaurant,
      menuItems,
      displayName: "",
      customerService,
      sendMessage,
    });

    assert.equal(sent.length, 1);
    assert.match(reply, /Hi Bola/);
    assert.match(reply, /Welcome to Mama's Spot/);
  });

  it("falls back to default greeting when no custom message set", async () => {
    const { restaurant, sendMessage, menuItems, displayName } = buildGreetingTestDeps({
      customWelcomeMessage: "",
      restaurantName: "Buka Joint",
      displayName: "",
      menuItems: [
        { name: "Jollof", price: 1200, available: true },
        { name: "Pepper Soup", price: 2000, available: true },
      ],
    });

    const reply = await runGreetingBranch({ restaurant, menuItems, displayName, sendMessage });

    assert.match(reply, /You're welcome at Buka Joint/);
    assert.match(reply, /Jollof/);
    assert.match(reply, /Reply MENU to see everything/);
  });

  it("falls back to default greeting when customWelcomeMessage is whitespace only", async () => {
    const { restaurant, sendMessage, menuItems, displayName } = buildGreetingTestDeps({
      customWelcomeMessage: "   ",
      restaurantName: "Wrap Shack",
      displayName: "",
      menuItems: [],
    });

    const reply = await runGreetingBranch({ restaurant, menuItems, displayName, sendMessage });

    assert.match(reply, /You're welcome at Wrap Shack/);
  });

  it("falls back gracefully when no menu items available and no custom message", async () => {
    const { restaurant, sendMessage, menuItems, displayName } = buildGreetingTestDeps({
      customWelcomeMessage: "",
      restaurantName: "Empty Kitchen",
      displayName: "",
      menuItems: [],
    });

    const reply = await runGreetingBranch({ restaurant, menuItems, displayName, sendMessage });

    assert.match(reply, /Reply MENU to see what is available today/);
  });
});
