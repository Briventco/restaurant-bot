async function generateGroqText({ apiKey, model, promptText, requestTimeoutMs = 15000 }) {
  if (!apiKey) {
    throw new Error("No Groq API key configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: promptText }],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (_error) {
        payload = { raw };
      }
    }

    if (!response.ok) {
      const message =
        payload && payload.error && payload.error.message
          ? payload.error.message
          : `Groq request failed with status ${response.status}`;
      throw new Error(message);
    }

    return payload &&
      Array.isArray(payload.choices) &&
      payload.choices[0] &&
      payload.choices[0].message &&
      payload.choices[0].message.content
      ? payload.choices[0].message.content
      : "";
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`Groq request timed out after ${requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  generateGroqText,
};
