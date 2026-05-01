let OpenAI = null;
try {
  OpenAI = require("openai");
} catch (_error) {
  OpenAI = null;
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

function normalizeDecision(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const confidence = Number(safe.confidence);
  const safeEntities =
    safe.entities && typeof safe.entities === "object" ? safe.entities : {};
  const safeItems = Array.isArray(safeEntities.items)
    ? safeEntities.items
        .filter((item) => item && typeof item === "string")
        .map((item) => String(item).trim())
        .filter(Boolean)
    : [];

  return {
    intent: String(safe.intent || "unknown").trim().toLowerCase() || "unknown",
    confidence: Number.isFinite(confidence) ? confidence : 0,
    replyText: String(safe.replyText || "").trim(),
    shouldStartGuidedFlow: Boolean(safe.shouldStartGuidedFlow),
    shouldHandleDirectly: Boolean(safe.shouldHandleDirectly),
    suggestedAction: String(safe.suggestedAction || "").trim().toLowerCase() || "",
    entities: {
      items: safeItems,
      quantity: Number.isFinite(Number(safeEntities.quantity))
        ? Number(safeEntities.quantity)
        : 0,
      fulfillmentType: String(safeEntities.fulfillmentType || "")
        .trim()
        .toLowerCase(),
      location: String(safeEntities.location || "").trim(),
      budget: Number.isFinite(Number(safeEntities.budget))
        ? Number(safeEntities.budget)
        : 0,
    },
  };
}

function buildDecisionPrompt({ restaurant, menuItems, messageText, conversationContext, activeOrder, sessionState }) {
  const restaurantName = String((restaurant && restaurant.name) || "the restaurant").trim();
  const menuText = (menuItems || [])
    .filter((item) => item.available)
    .map((item) => `${item.name} (N${item.price})`)
    .join(", ");
  
  const orderContext = activeOrder 
    ? `Active order: ${activeOrder.status}, items: ${(activeOrder.items || []).map(i => i.name).join(", ")}, total: N${activeOrder.total || 0}`
    : "No active order";
  
  const sessionContext = sessionState
    ? `Session state: ${sessionState.state || "none"}`
    : "No active session";

  return [
    "You are a smart, friendly WhatsApp assistant for a restaurant.",
    "You are the PRIMARY decision maker. Understand the customer's intent and suggest the best action.",
    "Return JSON only.",
    'Return exactly this shape: {"intent":"string","confidence":0.0,"replyText":"string","shouldStartGuidedFlow":false,"shouldHandleDirectly":false,"suggestedAction":"string","entities":{"items":[],"quantity":0,"fulfillmentType":"","location":"","budget":0}}',
    'Allowed intents: greeting, menu_request, stock_request, availability_question, recommendation, price_question, place_order, add_item, remove_item, delivery_question, cancel, confirm, question, support, off_topic, unknown.',
    'Allowed suggestedAction: show_menu, create_order, update_order, answer_question, start_guided_flow, clarify, cancel_order, confirm_order, handle_greeting.',
    "Set suggestedAction based on what the customer wants to do next.",
    "Set shouldStartGuidedFlow=true when launching the guided menu flow (same as suggestedAction=start_guided_flow).",
    "Set shouldHandleDirectly=true when replyText is a complete answer and no further action needed.",
    "Use concise, warm, business-safe replies.",
    "Consider the conversation context, active order, and session state to understand what the customer means.",
    "If customer has an active order, 'add rice' means add to that order, not start new.",
    "If customer is in a session, continue that flow instead of starting fresh.",
    "If the customer asks for an item that is not on the available menu, politely say it is not currently available and mention what is available instead.",
    "If the customer asks for a recommendation, base it only on the available menu.",
    "If the customer asks something you do not know, do not guess. Briefly say what you do know, offer helpful alternatives, and keep the conversation focused on the restaurant.",
    "Only redirect to the menu when the customer clearly wants to order or explicitly asks for the menu.",
    "For completely off-topic questions, politely stay focused on the restaurant and offer help with the menu, ordering, availability, or delivery.",
    conversationContext ? `Recent conversation: ${conversationContext}` : "",
    orderContext,
    sessionContext,
    `Restaurant name: ${restaurantName}`,
    `Available menu: ${menuText}`,
    `Customer message: ${messageText}`,
  ].join("\n");
}

async function classifyWithOpenAI({ openai, model, restaurant, menuItems, messageText, conversationContext, activeOrder, sessionState }) {
  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Classify restaurant customer messages into JSON only. " +
              'Return exactly {"intent":"string","confidence":0.0,"replyText":"string","shouldStartGuidedFlow":false,"shouldHandleDirectly":false,"suggestedAction":"string","entities":{...}}.',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildDecisionPrompt({ restaurant, menuItems, messageText, conversationContext, activeOrder, sessionState }),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "restaurant_message_decision",
        schema: {
          type: "object",
          additionalProperties: false,
          required: [
            "intent",
            "confidence",
              "replyText",
              "shouldStartGuidedFlow",
              "shouldHandleDirectly",
              "suggestedAction",
              "entities",
            ],
            properties: {
              intent: { type: "string" },
              confidence: { type: "number" },
              replyText: { type: "string" },
              shouldStartGuidedFlow: { type: "boolean" },
              shouldHandleDirectly: { type: "boolean" },
              suggestedAction: { type: "string" },
              entities: {
                type: "object",
                additionalProperties: false,
                required: ["items", "quantity", "fulfillmentType", "location", "budget"],
                properties: {
                  items: {
                    type: "array",
                    items: { type: "string" },
                  },
                  quantity: { type: "number" },
                  fulfillmentType: { type: "string" },
                  location: { type: "string" },
                  budget: { type: "number" },
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
  activeOrder,
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
                  text: buildDecisionPrompt({ restaurant, menuItems, messageText, conversationContext, activeOrder, sessionState }),
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
  openAIModel = "gpt-5-mini",
  geminiApiKey,
  geminiModel = "gemini-2.0-flash",
  requestTimeoutMs = 15000,
  logger,
}) {
  const normalizedProvider = String(llmProvider || "openai").trim().toLowerCase();
  const openai =
    openAIApiKey && OpenAI ? new OpenAI({ apiKey: openAIApiKey }) : null;

  async function classifyRestaurantMessage({ restaurant, menuItems, messageText, conversationContext = "", activeOrder = null, sessionState = null }) {
    const normalizedText = String(messageText || "").trim();
    if (!normalizedText) {
      return {
        intent: "unknown",
        confidence: 0,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
        suggestedAction: "",
        entities: {
          items: [],
          quantity: 0,
          fulfillmentType: "",
          location: "",
          budget: 0,
        },
      };
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
            activeOrder,
            sessionState,
            requestTimeoutMs,
          })) || {
            intent: "unknown",
            confidence: 0,
            replyText: "",
            shouldStartGuidedFlow: false,
            shouldHandleDirectly: false,
            suggestedAction: "",
            entities: {
              items: [],
              quantity: 0,
              fulfillmentType: "",
              location: "",
              budget: 0,
            },
          }
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
            activeOrder,
            sessionState,
          })) || {
            intent: "unknown",
            confidence: 0,
            replyText: "",
            shouldStartGuidedFlow: false,
            shouldHandleDirectly: false,
            suggestedAction: "",
            entities: {
              items: [],
              quantity: 0,
              fulfillmentType: "",
              location: "",
              budget: 0,
            },
          }
        );
      }

      
      return {
        intent: "unknown",
        confidence: 0,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
        suggestedAction: "",
        entities: {
          items: [],
          quantity: 0,
          fulfillmentType: "",
          location: "",
          budget: 0,
        },
      };
    } catch (error) {
      logger.warn("LLM message classification failed", {
        provider: normalizedProvider,
        message: error.message,
      });
      return {
        intent: "unknown",
        confidence: 0,
        replyText: "",
        shouldStartGuidedFlow: false,
        shouldHandleDirectly: false,
        suggestedAction: "",
        entities: {
          items: [],
          quantity: 0,
          fulfillmentType: "",
          location: "",
          budget: 0,
        },
      };
    }
  }

  return {
    classifyRestaurantMessage,
  };
}

module.exports = {
  createLlmService,
};
