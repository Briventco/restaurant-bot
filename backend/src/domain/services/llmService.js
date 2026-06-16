let OpenAI = null;
try {
  OpenAI = require("openai");
} catch (_error) {
  OpenAI = null;
}

const ALLOWED_INTENTS = new Set([
  "greeting",
  "menu_request",
  "place_order",
  "add_item",
  "remove_item",
  "confirm",
  "cancel",
  "unknown",
]);

const EMPTY_DECISION = {
  intent: "unknown",
  confidence: 0,
  entities: { items: [], fulfillmentType: "", location: "" },
};

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

function normalizeDecision(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const safeEntities = safe.entities && typeof safe.entities === "object" ? safe.entities : {};

  const safeItems = Array.isArray(safeEntities.items)
    ? safeEntities.items
        .filter((item) => item && typeof item === "object" && item.name)
        .map((item) => ({
          name: String(item.name || "").trim(),
          quantity: Math.max(1, Math.round(Number(item.quantity || 1))),
        }))
        .filter((item) => item.name)
    : [];

  const rawIntent = String(safe.intent || "unknown").trim().toLowerCase();
  const intent = ALLOWED_INTENTS.has(rawIntent) ? rawIntent : "unknown";
  const rawConfidence = Number(safe.confidence);

  return {
    intent,
    confidence: Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0,
    entities: {
      items: safeItems,
      fulfillmentType: String(safeEntities.fulfillmentType || "").trim().toLowerCase(),
      location: String(safeEntities.location || "").trim(),
    },
  };
}

function buildSessionMemoryContext(sessionState) {
  const state = sessionState && typeof sessionState === "object" ? sessionState : {};
  const sessionStateLabel = String(state.state || "none").trim() || "none";
  const summary = String(state.conversationSummary || "").trim();
  const lastIntent = String(state.llmLastIntent || "").trim().toLowerCase();

  const parts = [`Session state: ${sessionStateLabel}`];
  if (summary) {
    parts.push(`Session summary: ${summary}`);
  }
  if (lastIntent) {
    parts.push(`Last intent: ${lastIntent}`);
  }

  return parts.join(" | ");
}

function buildDecisionPrompt({ restaurant, menuItems, messageText, conversationContext, sessionState }) {
  const restaurantName = String((restaurant && restaurant.name) || "the restaurant").trim();

  // Provide item names only — not prices. The LLM must not state prices.
  const menuItemNames = (menuItems || [])
    .filter((item) => item.available)
    .map((item) => String(item.name || "").trim())
    .filter(Boolean)
    .join(", ");

  const sessionContext = sessionState ? buildSessionMemoryContext(sessionState) : "";

  return [
    "You are an extraction tool only. Your single job is to read the customer message and return structured JSON identifying their intent and extracting relevant entities. You do not write responses. You do not make decisions. You do not judge availability. You do not state prices. You only extract.",
    "",
    "Return JSON only. Return exactly this shape:",
    '{"intent":"string","confidence":0.0,"entities":{"items":[{"name":"string","quantity":0}],"fulfillmentType":"string","location":"string"}}',
    "",
    "Allowed intents: greeting, menu_request, place_order, add_item, remove_item, confirm, cancel, unknown.",
    "intent: the single best classification of what the customer wants to do.",
    "confidence: 0.0 to 1.0 — how certain you are about the intent.",
    "entities.items: items mentioned by the customer, each as {name, quantity}. Use the name exactly as the customer wrote it. Default quantity is 1 if not stated.",
    "entities.fulfillmentType: delivery, pickup, or empty string if not mentioned.",
    "entities.location: delivery area or address mentioned, or empty string.",
    "",
    "=== INTENT CLASSIFICATION RULES ===",
    "greeting       → customer is greeting (hi, hello, hey, good morning, how far, etc.)",
    "menu_request   → customer wants to see the menu, available items, or recommendations (menu, what do you have, what do you recommend, show me options)",
    "place_order    → customer wants to order something (I want rice, give me jollof, 2 amala)",
    "add_item       → customer wants to add to an existing order (add more rice, also give me chicken)",
    "remove_item    → customer wants to remove from their order (remove the chicken, cancel the rice)",
    "confirm        → customer is confirming something (yes, yeah, sure, ok, confirm, proceed)",
    "cancel         → customer wants to cancel (no, cancel, stop, nevermind)",
    "unknown        → anything else: price questions, delivery questions, availability questions, complaints, off-topic messages",
    "",
    "=== EXAMPLES ===",
    "'Hi' / 'Hello' / 'Hey' / 'Good morning' / 'How far' → intent: greeting, confidence: 0.95",
    "'Menu' / 'What do you have' / 'What is available' / 'What do you recommend' → intent: menu_request, confidence: 0.95",
    "'I want rice' → intent: place_order, items: [{name:'rice',quantity:1}]",
    "'2 amala and 1 rice for delivery to Yaba' → intent: place_order, items: [{name:'amala',quantity:2},{name:'rice',quantity:1}], fulfillmentType: delivery, location: Yaba",
    "'I want to pick up my order' → intent: place_order, fulfillmentType: pickup",
    "'Add more chicken' → intent: add_item, items: [{name:'chicken',quantity:1}]",
    "'Remove the chicken' → intent: remove_item, items: [{name:'chicken',quantity:1}]",
    "'Yes' / 'Yeah' / 'Sure' / 'Confirm' / 'OK' → intent: confirm, confidence: 0.95",
    "'No' / 'Cancel' / 'Stop' → intent: cancel, confidence: 0.95",
    "'Do you deliver to Yaba' / 'How much is rice' / 'Do you have amala' → intent: unknown, confidence: 0.7",
    "",
    sessionContext ? `Session context: ${sessionContext}` : "",
    conversationContext ? `Recent conversation: ${conversationContext}` : "",
    `Restaurant: ${restaurantName}`,
    `Menu items (for entity extraction reference only — do NOT state prices or judge availability): ${menuItemNames || "none"}`,
    `Customer message: ${messageText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function classifyWithOpenAI({ openai, model, restaurant, menuItems, messageText, conversationContext, sessionState }) {
  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "You are an extraction tool. Classify the customer message and extract entities. Return JSON only.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildDecisionPrompt({ restaurant, menuItems, messageText, conversationContext, sessionState }),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "restaurant_message_extraction",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["intent", "confidence", "entities"],
          properties: {
            intent: { type: "string" },
            confidence: { type: "number" },
            entities: {
              type: "object",
              additionalProperties: false,
              required: ["items", "fulfillmentType", "location"],
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
                fulfillmentType: { type: "string" },
                location: { type: "string" },
              },
            },
          },
        },
      },
    },
  });

  if (!response.output_text) {
    return null;
  }

  return normalizeDecision(JSON.parse(response.output_text));
}

async function classifyWithGemini({
  apiKey,
  model,
  restaurant,
  menuItems,
  messageText,
  conversationContext,
  sessionState,
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
                  text: buildDecisionPrompt({ restaurant, menuItems, messageText, conversationContext, sessionState }),
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

    return normalizeDecision(extractJsonObject(text));
  } finally {
    clearTimeout(timeout);
  }
}

function createLlmService({
  llmProvider = "openai",
  openAIApiKey,
  openAIModel = "gpt-4o-mini",
  geminiApiKey,
  geminiModel = "gemini-2.0-flash",
  requestTimeoutMs = 15000,
  logger,
}) {
  const normalizedProvider = String(llmProvider || "openai").trim().toLowerCase();
  const openai =
    openAIApiKey && OpenAI ? new OpenAI({ apiKey: openAIApiKey }) : null;

  function fallbackIntentHeuristic(text) {
    const lower = String(text || "").trim().toLowerCase();
    if (!lower) {
      return "unknown";
    }
    if (
      lower === "hi" ||
      lower === "hello" ||
      lower === "hey" ||
      lower.includes("good morning") ||
      lower.includes("good afternoon") ||
      lower.includes("good evening")
    ) {
      return "greeting";
    }
    if (
      lower.includes("menu") ||
      lower.includes("what do you have") ||
      lower.includes("what is available") ||
      lower.includes("wetin una get")
    ) {
      return "menu_request";
    }
    if (
      lower.includes("i want") ||
      lower.includes("i would like") ||
      lower.includes("order food") ||
      lower.includes("i wan") ||
      /\b\d+\b/.test(lower)
    ) {
      return "place_order";
    }
    if (
      lower.includes("how are you") ||
      lower.includes("how far") ||
      lower.includes("i'm hungry") ||
      lower.includes("im hungry") ||
      lower.includes("what can i get")
    ) {
      return "greeting";
    }
    return "unknown";
  }

  async function classifyIntentWithOpenAI(messageText) {
    const response = await openai.responses.create({
      model: openAIModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Classify restaurant chat intent. Return JSON only with one field intent. " +
                'Allowed intents: greeting, menu_request, place_order, unknown.',
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Message: ${String(messageText || "").trim()}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "intent_classifier",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["intent"],
            properties: {
              intent: {
                type: "string",
                enum: ["greeting", "menu_request", "place_order", "unknown"],
              },
            },
          },
        },
      },
    });

    if (!response.output_text) {
      return null;
    }
    const parsed = JSON.parse(response.output_text);
    return String(parsed.intent || "").trim().toLowerCase() || "unknown";
  }

  async function classifyIntentWithGemini(messageText) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          geminiModel
        )}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
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
                    text: [
                      "Classify restaurant chat intent.",
                      'Return JSON only: {"intent":"greeting|menu_request|place_order|unknown"}',
                      `Message: ${String(messageText || "").trim()}`,
                    ].join("\n"),
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

      const extracted = extractJsonObject(text);
      return String((extracted && extracted.intent) || "").trim().toLowerCase() || "unknown";
    } finally {
      clearTimeout(timeout);
    }
  }

  async function classifyIntent({ messageText }) {
    const normalizedText = String(messageText || "").trim();
    if (!normalizedText) {
      return { intent: "unknown", source: "empty" };
    }

    try {
      if (normalizedProvider === "gemini" && geminiApiKey) {
        const intent = await classifyIntentWithGemini(normalizedText);
        return { intent, source: "llm_gemini" };
      }
      if (normalizedProvider === "openai" && openai) {
        const intent = await classifyIntentWithOpenAI(normalizedText);
        return { intent, source: "llm_openai" };
      }
    } catch (error) {
      logger.warn("LLM intent classification failed", {
        provider: normalizedProvider,
        message: error.message,
      });
    }

    return { intent: fallbackIntentHeuristic(normalizedText), source: "heuristic_fallback" };
  }

  async function classifyRestaurantMessage({ restaurant, menuItems, messageText, conversationContext = "", sessionState = null }) {
    const normalizedText = String(messageText || "").trim();
    if (!normalizedText) {
      return { ...EMPTY_DECISION };
    }

    try {
      if (normalizedProvider === "gemini" && geminiApiKey) {
        return (
          (await classifyWithGemini({
            apiKey: geminiApiKey,
            model: geminiModel,
            restaurant,
            menuItems,
            messageText: normalizedText,
            conversationContext,
            sessionState,
            requestTimeoutMs,
          })) || { ...EMPTY_DECISION }
        );
      }

      if (normalizedProvider === "openai" && openai) {
        return (
          (await classifyWithOpenAI({
            openai,
            model: openAIModel,
            restaurant,
            menuItems,
            messageText: normalizedText,
            conversationContext,
            sessionState,
          })) || { ...EMPTY_DECISION }
        );
      }

      return { ...EMPTY_DECISION };
    } catch (error) {
      logger.warn("LLM message classification failed", {
        provider: normalizedProvider,
        message: error.message,
      });
      return { ...EMPTY_DECISION };
    }
  }

  return {
    classifyRestaurantMessage,
    classifyIntent,
  };
}

module.exports = {
  createLlmService,
};
