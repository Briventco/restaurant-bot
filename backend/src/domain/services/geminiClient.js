function isRetryableGeminiError(status, message) {
  if (status === 429 || status >= 500) {
    return true;
  }
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("resource_exhausted")
  );
}

function extractCandidateText(payload) {
  return payload &&
    Array.isArray(payload.candidates) &&
    payload.candidates[0] &&
    payload.candidates[0].content &&
    Array.isArray(payload.candidates[0].content.parts) &&
    payload.candidates[0].content.parts[0] &&
    payload.candidates[0].content.parts[0].text
    ? payload.candidates[0].content.parts[0].text
    : "";
}

async function generateGeminiText({ apiKeys, model, promptText, requestTimeoutMs = 15000, logger }) {
  const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys])
    .map((key) => String(key || "").trim())
    .filter(Boolean);

  if (!keys.length) {
    throw new Error("No Gemini API key configured");
  }

  let lastError = null;

  for (let index = 0; index < keys.length; index += 1) {
    const apiKey = keys[index];
    const isLastKey = index === keys.length - 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
          signal: controller.signal,
        }
      );

      const payload = await response.json();

      if (!response.ok) {
        const message =
          payload && payload.error && payload.error.message
            ? payload.error.message
            : `Gemini request failed with status ${response.status}`;

        if (!isLastKey && isRetryableGeminiError(response.status, message)) {
          lastError = new Error(message);
          if (logger) {
            logger.warn("Gemini key exhausted or rate-limited, rotating to next key", {
              keyIndex: index,
              status: response.status,
            });
          }
          continue;
        }
        throw new Error(message);
      }

      return extractCandidateText(payload);
    } catch (error) {
      lastError =
        error && error.name === "AbortError"
          ? new Error(`Gemini request timed out after ${requestTimeoutMs}ms`)
          : error;

      if (!isLastKey) {
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Gemini request failed for all configured keys");
}

module.exports = { generateGeminiText };
