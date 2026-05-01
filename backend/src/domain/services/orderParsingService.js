const { normalizeText } = require("../utils/text");

let OpenAI = null;
try {
  OpenAI = require("openai");
} catch (_error) {
  OpenAI = null;
}

function toSafeQuantity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }

  return Math.max(1, Math.round(parsed));
}

function sumQuantities(items) {
  return (items || []).reduce((sum, item) => sum + toSafeQuantity(item.quantity), 0);
}

function parseWithRegex(messageText, menuItems) {
  const lower = normalizeText(messageText);
  const items = [];

  for (const menuItem of menuItems || []) {
    const escaped = menuItem.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const qtyRegex = new RegExp(`(\\d+)\\s*(x\\s*)?${escaped}(\\b|$)`, "i");
    const qtyMatch = lower.match(qtyRegex);

    if (qtyMatch) {
      items.push({
        name: menuItem.name,
        quantity: toSafeQuantity(qtyMatch[1]),
      });
      continue;
    }

    if (lower.includes(normalizeText(menuItem.name))) {
      items.push({
        name: menuItem.name,
        quantity: 1,
      });
    }
  }

  return items;
}

function parseStructuredItems(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    return [];
  }

  return raw.items
    .filter((item) => item && typeof item.name === "string")
    .map((item) => ({
      name: item.name,
      quantity: toSafeQuantity(item.quantity),
    }));
}

function collapseItems(items) {
  const collapsed = new Map();

  for (const item of items || []) {
    if (!item || typeof item.name !== "string") {
      continue;
    }

    const normalizedName = normalizeText(item.name);
    if (!normalizedName) {
      continue;
    }

    const existing = collapsed.get(normalizedName);
    if (existing) {
      existing.quantity += toSafeQuantity(item.quantity);
      continue;
    }

    collapsed.set(normalizedName, {
      name: item.name,
      quantity: toSafeQuantity(item.quantity),
    });
  }

  return Array.from(collapsed.values());
}

function sanitizeItemsToMenu(items, menuItems) {
  const collapsedItems = collapseItems(items);
  const menuLookup = new Map(
    (menuItems || [])
      .filter((item) => item && typeof item.name === "string")
      .map((item) => [normalizeText(item.name), item])
  );

  if (!menuLookup.size) {
    return {
      items: [],
      droppedItemCount: collapsedItems.length,
      menuMissing: true,
    };
  }

  const matched = [];
  let droppedItemCount = 0;

  for (const item of collapsedItems) {
    const found = menuLookup.get(normalizeText(item.name));
    if (!found) {
      droppedItemCount += 1;
      continue;
    }

    matched.push({
      name: found.name,
      quantity: toSafeQuantity(item.quantity),
    });
  }

  return {
    items: collapseItems(matched),
    droppedItemCount,
    menuMissing: false,
  };
}

function normalizeDeliveryOrPickup(value) {
  const lower = normalizeText(value);
  if (!lower) {
    return "";
  }

  if (
    lower === "delivery" ||
    lower === "d" ||
    lower.includes("delivery") ||
    lower.includes("deliver")
  ) {
    return "delivery";
  }

  if (
    lower === "pickup" ||
    lower === "pick up" ||
    lower === "pick-up" ||
    lower === "p" ||
    lower.includes("pickup") ||
    lower.includes("pick up") ||
    lower.includes("collect")
  ) {
    return "pickup";
  }

  return "";
}

function sanitizeAddress(value) {
  return String(value || "")
    .replace(/^[\s,:-]+|[\s,:-]+$/g, "")
    .replace(/[?!.,]+$/g, "")
    .trim();
}

function extractFallbackAddress(messageText) {
  const raw = String(messageText || "").trim();
  if (!raw) {
    return "";
  }

  const patterns = [
    /\b(?:delivery|deliver|send|drop\s*off)(?:\s+(?:it|am|the\s+order|the\s+food|order|food))?(?:\s+to)?\s+(.+)$/i,
    /\b(?:address|location)\s*[:\-]?\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && match[1]) {
      return sanitizeAddress(match[1]);
    }
  }

  return "";
}

function detectPaymentIntent(messageText) {
  const lower = normalizeText(messageText);
  if (!lower) {
    return "not_specified";
  }

  if (
    lower === "paid" ||
    lower === "payment made" ||
    lower === "payment sent" ||
    lower === "i have paid" ||
    lower === "i paid" ||
    lower.includes("i have paid") ||
    lower.includes("i paid") ||
    lower.includes("payment sent") ||
    lower.includes("payment done") ||
    lower.includes("transfer made") ||
    lower.includes("transfer done") ||
    lower.includes("sent proof") ||
    lower.includes("payment proof")
  ) {
    return "payment_sent";
  }

  if (
    lower.includes("cash on delivery") ||
    lower.includes("pay on delivery") ||
    lower.includes("cod")
  ) {
    return "cash_on_delivery";
  }

  if (
    lower.includes("bank transfer") ||
    lower.includes("transfer") ||
    lower.includes("card") ||
    lower.includes("payment") ||
    lower.includes("pay ")
  ) {
    return "wants_to_pay";
  }

  return "not_specified";
}

function looksLikeGreeting(lower) {
  return (
    lower === "hi" ||
    lower === "hello" ||
    lower === "hey" ||
    lower === "good morning" ||
    lower === "good afternoon" ||
    lower === "good evening"
  );
}

function looksLikeMenuRequest(lower) {
  return (
    lower === "menu" ||
    lower === "start" ||
    lower.includes("show menu") ||
    lower.includes("show me the menu") ||
    lower.includes("what do you have") ||
    lower.includes("what is available") ||
    lower.includes("what do you have in stock") ||
    lower.includes("in stock")
  );
}

function looksLikeOrderAttempt(lower) {
  return (
    lower.includes("i want") ||
    lower.includes("i would like") ||
    lower.includes("can i order") ||
    lower.includes("order ") ||
    lower.includes("buy ") ||
    lower.includes("get ") ||
    lower.includes("make i get") ||
    lower.includes("abeg")
  );
}

function looksLikeQuantityLedOrder(rawText) {
  const lower = normalizeText(rawText);
  if (!lower || lower.startsWith("address") || lower.startsWith("location")) {
    return false;
  }

  return /(?:^|\b)\d+\s*(?:x\s*)?[a-z]/i.test(String(rawText || ""));
}

function buildFallbackInterpretation(messageText, menuItems) {
  const rawItems = parseWithRegex(messageText, menuItems);
  const { items, droppedItemCount, menuMissing } = sanitizeItemsToMenu(rawItems, menuItems);
  const lower = normalizeText(messageText);
  const deliveryOrPickup = normalizeDeliveryOrPickup(messageText);
  const address =
    deliveryOrPickup === "delivery" ? extractFallbackAddress(messageText) : "";
  const paymentIntent = detectPaymentIntent(messageText);

  let intent = "unknown";
  if (items.length || looksLikeOrderAttempt(lower) || looksLikeQuantityLedOrder(messageText)) {
    intent = "place_order";
  } else if (paymentIntent === "payment_sent") {
    intent = "payment_update";
  } else if (looksLikeMenuRequest(lower)) {
    intent = "menu_request";
  } else if (paymentIntent !== "not_specified") {
    intent = "payment_intent";
  } else if (deliveryOrPickup) {
    intent = "delivery_question";
  } else if (looksLikeGreeting(lower)) {
    intent = "greeting";
  } else if (lower.includes("help") || lower.includes("support")) {
    intent = "support";
  }

  const clarificationNeeded =
    intent === "unknown" ||
    droppedItemCount > 0 ||
    menuMissing ||
    (intent === "place_order" && !items.length) ||
    (intent === "place_order" && !deliveryOrPickup) ||
    (deliveryOrPickup === "delivery" && !address);

  return {
    intent,
    items,
    quantity: sumQuantities(items),
    deliveryOrPickup,
    address,
    paymentIntent,
    clarificationNeeded,
  };
}

function normalizeInterpretation(raw, menuItems, fallback) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const {
    items: structuredItems,
    droppedItemCount,
    menuMissing,
  } = sanitizeItemsToMenu(parseStructuredItems(safe), menuItems);
  const items = structuredItems.length ? structuredItems : fallback.items;
  const intent =
    String(safe.intent || fallback.intent || "unknown").trim().toLowerCase() || "unknown";
  const deliveryOrPickup = normalizeDeliveryOrPickup(
    safe.deliveryOrPickup || safe.fulfillmentType || fallback.deliveryOrPickup
  );
  const address = sanitizeAddress(
    safe.address || (deliveryOrPickup === "delivery" ? fallback.address : "")
  );
  const paymentIntent =
    String(safe.paymentIntent || "").trim().toLowerCase() || fallback.paymentIntent;

  return {
    intent,
    items,
    quantity: sumQuantities(items),
    deliveryOrPickup,
    address,
    paymentIntent,
    clarificationNeeded:
      Boolean(safe.clarificationNeeded) ||
      fallback.clarificationNeeded ||
      droppedItemCount > 0 ||
      menuMissing ||
      (intent === "place_order" && !items.length) ||
      (intent === "place_order" && !deliveryOrPickup) ||
      (deliveryOrPickup === "delivery" && !address),
  };
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch (_error) {
      return null;
    }
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch (_error) {
      return null;
    }
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function buildPrompt(messageText, menuItems) {
  const menuText = (menuItems || [])
    .map((item) => `${item.name} (N${item.price})`)
    .join(", ");

  return [
    "You extract restaurant food orders into JSON only.",
    'Return exactly this shape: {"items":[{"name":"Menu Item Name","quantity":1}]}',
    "Use only names from the provided menu.",
    'If nothing valid is ordered, return {"items":[]}.',
    `Menu: ${menuText}`,
    `Customer message: ${messageText}`,
  ].join("\n");
}

function buildInterpretationPrompt(messageText, menuItems) {
  const menuText = (menuItems || [])
    .map((item) => `${item.name}${item && item.available === false ? " (unavailable)" : ""}`)
    .join(", ");

  return [
    "You are Servra AI, an ordering assistant for restaurants and online sellers.",
    "Your job is to understand customer messages and return structured JSON only.",
    "Do not calculate prices yourself.",
    "Do not invent menu items.",
    "Do not confirm payment yourself.",
    "Do not finalize an order unless the backend says it is valid.",
    "Understand natural language, voice transcription text, pidgin, typos, and short messages.",
    'Return exactly this shape: {"intent":"string","items":[{"name":"string","quantity":1}],"quantity":0,"deliveryOrPickup":"","address":"","paymentIntent":"not_specified","clarificationNeeded":false}',
    "Use only names from the provided menu when filling items.",
    "If a requested item is not on the menu, leave it out of items and set clarificationNeeded to true.",
    'Set deliveryOrPickup to "delivery", "pickup", or "".',
    'Set paymentIntent to a short machine-friendly label such as "not_specified", "payment_sent", "wants_to_pay", or "cash_on_delivery".',
    'Set intent to a short machine-friendly label such as "place_order", "menu_request", "payment_update", "payment_intent", "delivery_question", "greeting", "support", or "unknown".',
    "quantity must be the sum of all quantities in items.",
    `Menu: ${menuText}`,
    `Customer message: ${messageText}`,
  ].join("\n");
}

async function parseWithOpenAI({ openai, model, messageText, menuItems }) {
  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You extract food orders into JSON only. " +
              'Return exactly {"items":[{"name":"string","quantity":number}]}.',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildPrompt(messageText, menuItems),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "food_order",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "quantity"],
                properties: {
                  name: { type: "string" },
                  quantity: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!response.output_text) {
    return [];
  }

  return parseStructuredItems(JSON.parse(response.output_text));
}

async function interpretWithOpenAI({ openai, model, messageText, menuItems }) {
  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are Servra AI. Return structured restaurant-order JSON only. " +
              'Return exactly {"intent":"string","items":[{"name":"string","quantity":1}],"quantity":0,"deliveryOrPickup":"","address":"","paymentIntent":"not_specified","clarificationNeeded":false}.',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildInterpretationPrompt(messageText, menuItems),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "servra_customer_message",
        schema: {
          type: "object",
          additionalProperties: false,
          required: [
            "intent",
            "items",
            "quantity",
            "deliveryOrPickup",
            "address",
            "paymentIntent",
            "clarificationNeeded",
          ],
          properties: {
            intent: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "quantity"],
                properties: {
                  name: { type: "string" },
                  quantity: { type: "number" },
                },
              },
            },
            quantity: { type: "number" },
            deliveryOrPickup: { type: "string" },
            address: { type: "string" },
            paymentIntent: { type: "string" },
            clarificationNeeded: { type: "boolean" },
          },
        },
      },
    },
  });

  if (!response.output_text) {
    return null;
  }

  return JSON.parse(response.output_text);
}

async function parseWithGemini({
  apiKey,
  model,
  messageText,
  menuItems,
  requestTimeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: buildPrompt(messageText, menuItems),
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      }
    );

    const payload = await response.json();
    if (!response.ok) {
      const message =
        payload &&
        payload.error &&
        payload.error.message
          ? payload.error.message
          : `Gemini request failed with status ${response.status}`;
      throw new Error(message);
    }

    const text =
      payload &&
      Array.isArray(payload.candidates) &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      Array.isArray(payload.candidates[0].content.parts) &&
      payload.candidates[0].content.parts[0] &&
      payload.candidates[0].content.parts[0].text
        ? payload.candidates[0].content.parts[0].text
        : "";

    return parseStructuredItems(extractJsonObject(text));
  } finally {
    clearTimeout(timeout);
  }
}

async function interpretWithGemini({
  apiKey,
  model,
  messageText,
  menuItems,
  requestTimeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: buildInterpretationPrompt(messageText, menuItems),
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      }
    );

    const payload = await response.json();
    if (!response.ok) {
      const message =
        payload &&
        payload.error &&
        payload.error.message
          ? payload.error.message
          : `Gemini request failed with status ${response.status}`;
      throw new Error(message);
    }

    const text =
      payload &&
      Array.isArray(payload.candidates) &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      Array.isArray(payload.candidates[0].content.parts) &&
      payload.candidates[0].content.parts[0] &&
      payload.candidates[0].content.parts[0].text
        ? payload.candidates[0].content.parts[0].text
        : "";

    return extractJsonObject(text);
  } finally {
    clearTimeout(timeout);
  }
}

function createOrderParsingService({
  llmProvider = "openai",
  openAIApiKey,
  openAIModel = "gpt-5-mini",
  geminiApiKey,
  geminiModel = "gemini-2.0-flash",
  logger,
  requestTimeoutMs = 15000,
}) {
  const normalizedProvider = String(llmProvider || "openai").trim().toLowerCase();

  if (openAIApiKey && !OpenAI) {
    logger.warn("OpenAI SDK not installed; OpenAI parsing will fall back");
  }

  const openai =
    openAIApiKey && OpenAI ? new OpenAI({ apiKey: openAIApiKey }) : null;

  async function parseOrder(messageText, menuItems) {
    const fallback = parseWithRegex(messageText, menuItems);

    try {
      if (normalizedProvider === "gemini" && geminiApiKey) {
        const parsed = await parseWithGemini({
          apiKey: geminiApiKey,
          model: geminiModel,
          messageText,
          menuItems,
          requestTimeoutMs,
        });
        return parsed.length ? parsed : fallback;
      }

      if (normalizedProvider === "openai" && openai) {
        const parsed = await parseWithOpenAI({
          openai,
          model: openAIModel,
          messageText,
          menuItems,
        });
        return parsed.length ? parsed : fallback;
      }

      if (normalizedProvider === "gemini" && !geminiApiKey) {
        logger.warn("Gemini provider selected but GEMINI_API_KEY is missing; using regex fallback");
      } else if (normalizedProvider === "openai" && !openai) {
        logger.warn("OpenAI provider selected but OpenAI is unavailable; using regex fallback");
      }

      return fallback;
    } catch (error) {
      logger.warn("LLM order parsing failed, using regex fallback", {
        provider: normalizedProvider,
        message: error.message,
      });
      return fallback;
    }
  }

  async function interpretCustomerMessage(messageText, menuItems) {
    const fallback = buildFallbackInterpretation(messageText, menuItems);

    try {
      if (normalizedProvider === "gemini" && geminiApiKey) {
        const interpreted = await interpretWithGemini({
          apiKey: geminiApiKey,
          model: geminiModel,
          messageText,
          menuItems,
          requestTimeoutMs,
        });
        return normalizeInterpretation(interpreted, menuItems, fallback);
      }

      if (normalizedProvider === "openai" && openai) {
        const interpreted = await interpretWithOpenAI({
          openai,
          model: openAIModel,
          messageText,
          menuItems,
        });
        return normalizeInterpretation(interpreted, menuItems, fallback);
      }

      if (normalizedProvider === "gemini" && !geminiApiKey) {
        logger.warn(
          "Gemini provider selected but GEMINI_API_KEY is missing; using structured fallback"
        );
      } else if (normalizedProvider === "openai" && !openai) {
        logger.warn(
          "OpenAI provider selected but OpenAI is unavailable; using structured fallback"
        );
      }

      return fallback;
    } catch (error) {
      logger.warn("LLM structured parsing failed, using fallback", {
        provider: normalizedProvider,
        message: error.message,
      });
      return fallback;
    }
  }

  return {
    parseOrder,
    interpretCustomerMessage,
  };
}

module.exports = {
  createOrderParsingService,
  parseWithRegex,
  parseStructuredItems,
};
