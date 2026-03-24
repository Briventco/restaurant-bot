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

function parseOpenAIOutput(raw) {
  if (!raw || typeof raw !== "object") {
    return [];
  }

  if (!Array.isArray(raw.items)) {
    return [];
  }

  return raw.items
    .filter((item) => item && typeof item.name === "string")
    .map((item) => ({
      name: item.name,
      quantity: toSafeQuantity(item.quantity),
    }));
}

function createOrderParsingService({ openAIApiKey, logger }) {
  if (openAIApiKey && !OpenAI) {
    logger.warn("OpenAI SDK not installed; using regex parser fallback only");
  }

  const openai =
    openAIApiKey && OpenAI ? new OpenAI({ apiKey: openAIApiKey }) : null;

  async function parseOrder(messageText, menuItems) {
    const fallback = parseWithRegex(messageText, menuItems);

    if (!openai) {
      return fallback;
    }

    try {
      const menuText = (menuItems || [])
        .map((item) => `${item.name} (₦${item.price})`)
        .join(", ");

      const response = await openai.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "You extract food orders into JSON only. " +
                  "Return items using the menu provided. " +
                  "If nothing is ordered, return {\"items\":[]}",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Menu: ${menuText}\nCustomer message: ${messageText}`,
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
        return fallback;
      }

      const parsed = parseOpenAIOutput(JSON.parse(response.output_text));
      return parsed.length ? parsed : fallback;
    } catch (error) {
      logger.warn("OpenAI parsing failed, using regex fallback", {
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
  parseOpenAIOutput,
};
