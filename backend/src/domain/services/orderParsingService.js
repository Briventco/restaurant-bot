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

  return {
    parseOrder,
  };
}

module.exports = {
  createOrderParsingService,
  parseWithRegex,
  parseStructuredItems,
};
