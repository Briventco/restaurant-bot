const DEMO_STATES = {
  AWAITING_SELECTION: "number_demo_awaiting_selection",
  AWAITING_PAYMENT: "number_demo_awaiting_payment",
};

const PRODUCTS = [
  {
    code: "UK",
    id: "uk_virtual",
    label: "UK +44 Virtual Number",
    price: 25000,
    inventory: ["+447700900101", "+447700900102", "+447700900103"],
  },
  {
    code: "US",
    id: "us_virtual",
    label: "US +1 Virtual Number",
    price: 20000,
    inventory: ["+12025550101", "+12025550102", "+12025550103"],
  },
  {
    code: "CA",
    id: "ca_virtual",
    label: "Canada +1 Virtual Number",
    price: 22000,
    inventory: ["+14375550101", "+14375550102", "+14375550103"],
  },
];

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function createNumberSellerDemoService({
  conversationSessionRepo,
}) {
  const allocationsByRestaurant = new Map();

  function getRestaurantAllocations(restaurantId) {
    if (!allocationsByRestaurant.has(restaurantId)) {
      allocationsByRestaurant.set(restaurantId, new Set());
    }
    return allocationsByRestaurant.get(restaurantId);
  }

  function buildCatalogText() {
    const lines = [];
    lines.push("Available foreign numbers:");
    lines.push("");
    for (let index = 0; index < PRODUCTS.length; index += 1) {
      const product = PRODUCTS[index];
      lines.push(`${index + 1}. ${product.label} - N${product.price.toLocaleString()}`);
    }
    lines.push("");
    lines.push("Reply with the number of your choice (1, 2, or 3).");
    return lines.join("\n");
  }

  function shouldEnterDemo(lower) {
    return (
      lower === "numbers" ||
      lower.includes("foreign number") ||
      lower.includes("virtual number") ||
      lower.includes("buy number")
    );
  }

  function parseSelection(lower) {
    if (["1", "2", "3"].includes(lower)) {
      return Number(lower) - 1;
    }
    const idx = PRODUCTS.findIndex(
      (product) =>
        lower === product.code.toLowerCase() ||
        lower.includes(product.code.toLowerCase()) ||
        lower.includes(product.label.toLowerCase())
    );
    return idx;
  }

  function allocateNumber(restaurantId, productIndex) {
    const product = PRODUCTS[productIndex];
    if (!product) {
      return "";
    }
    const allocations = getRestaurantAllocations(restaurantId);
    const next = product.inventory.find((item) => !allocations.has(item));
    if (!next) {
      return "";
    }
    allocations.add(next);
    return next;
  }

  async function startDemo({ restaurantId, normalized, sendText, sendMessage }) {
    await conversationSessionRepo.upsertSession(
      restaurantId,
      normalized.channel,
      normalized.channelCustomerId,
      {
        role: "number_seller_demo",
        state: DEMO_STATES.AWAITING_SELECTION,
      }
    );

    const replyText = buildCatalogText();
    await sendText(sendMessage, normalized.channelCustomerId, replyText);
    return {
      handled: true,
      shouldReply: true,
      type: "number_demo_catalog",
      replyText,
    };
  }

  async function handleMessage({
    restaurantId,
    restaurant,
    normalized,
    existingSession,
    sendText,
    sendMessage,
  }) {
    const bot =
      restaurant && restaurant.bot && typeof restaurant.bot === "object"
        ? restaurant.bot
        : {};
    const demoEnabled = bot.demoNumberSellerEnabled === true;
    const lower = normalizeText(normalized.text);
    const isDemoSession =
      existingSession &&
      (existingSession.role === "number_seller_demo" ||
        String(existingSession.state || "").startsWith("number_demo_"));

    if (!demoEnabled && !isDemoSession) {
      return null;
    }

    if (!isDemoSession && !shouldEnterDemo(lower)) {
      return null;
    }

    if (!isDemoSession) {
      return startDemo({ restaurantId, normalized, sendText, sendMessage });
    }

    if (lower === "cancel" || lower === "stop") {
      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );
      const replyText = "Cancelled. Send NUMBERS whenever you want to buy a foreign number.";
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "number_demo_cancelled",
        replyText,
      };
    }

    if (existingSession.state === DEMO_STATES.AWAITING_SELECTION) {
      const selection = parseSelection(lower);
      if (selection < 0) {
        const replyText = "Please reply with 1, 2, or 3 to choose a number plan.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "number_demo_invalid_selection",
          replyText,
        };
      }

      const product = PRODUCTS[selection];
      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          role: "number_seller_demo",
          state: DEMO_STATES.AWAITING_PAYMENT,
          selectedProductIndex: selection,
        }
      );

      const replyText =
        `Great choice.\n${product.label} - N${product.price.toLocaleString()}\n\n` +
        "Payment simulation: reply PAY NOW to complete this demo purchase.";
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "number_demo_payment_prompt",
        replyText,
      };
    }

    if (existingSession.state === DEMO_STATES.AWAITING_PAYMENT) {
      if (!(lower === "pay now" || lower === "pay" || lower === "paid")) {
        const replyText = "Reply PAY NOW to complete payment simulation, or CANCEL to stop.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "number_demo_payment_waiting",
          replyText,
        };
      }

      const selectedIndex = Number(existingSession.selectedProductIndex);
      const product = PRODUCTS[selectedIndex];
      const allocatedNumber = allocateNumber(restaurantId, selectedIndex);

      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );

      if (!product || !allocatedNumber) {
        const replyText =
          "Payment simulated successfully, but this number plan is currently sold out. Please try another plan.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "number_demo_out_of_stock",
          replyText,
        };
      }

      const replyText =
        "Payment confirmed (simulation).\n" +
        `Your allocated number is: ${allocatedNumber}\n` +
        `Plan: ${product.label}\n\n` +
        "Thank you for your purchase.";
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "number_demo_fulfilled",
        replyText,
      };
    }

    return null;
  }

  return {
    handleMessage,
  };
}

module.exports = {
  createNumberSellerDemoService,
};
