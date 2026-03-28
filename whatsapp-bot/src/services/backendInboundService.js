function createBackendInboundService({
  backendBaseUrl,
  backendApiPrefix,
  restaurantId,
  apiKey,
  requestTimeoutMs,
  logger,
}) {
  const baseUrl = String(backendBaseUrl || "").replace(/\/+$/, "");
  const normalizedApiPrefix = String(backendApiPrefix || "/api/v1")
    .trim()
    .replace(/\/+$/, "")
    .replace(/^([^/])/, "/$1");

  function ensureConfigured() {
    if (!baseUrl) {
      throw new Error("BACKEND_API_BASE_URL is required");
    }

    if (!restaurantId) {
      throw new Error("BOT_RESTAURANT_ID is required");
    }

    if (!apiKey) {
      throw new Error("BACKEND_API_KEY is required");
    }
  }

  function buildUrl() {
    return `${baseUrl}${normalizedApiPrefix}/restaurants/${encodeURIComponent(
      restaurantId
    )}/messages/inbound`;
  }

  async function processInbound(normalizedMessage) {
    ensureConfigured();

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    try {
      const response = await fetch(buildUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          channel: normalizedMessage.channel,
          channelCustomerId: normalizedMessage.channelCustomerId,
          customerPhone: normalizedMessage.customerPhone,
          displayName: normalizedMessage.displayName || "",
          text: normalizedMessage.body,
          providerMessageId: normalizedMessage.messageId,
          timestamp: normalizedMessage.timestamp,
          type: normalizedMessage.type || "chat",
          isFromMe: normalizedMessage.isFromMe,
          isStatus: normalizedMessage.isStatus,
          isBroadcast: normalizedMessage.isBroadcast,
        }),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const payload = rawText ? JSON.parse(rawText) : {};

      if (!response.ok) {
        const message = payload.error || `HTTP ${response.status}`;
        throw new Error(`Backend inbound request failed: ${message}`);
      }

      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        logger.error("Backend inbound call timed out", {
          timeoutMs: requestTimeoutMs,
        });
        throw new Error("Backend inbound request timed out");
      }

      logger.error("Backend inbound call failed", {
        message: error.message,
      });
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  return {
    processInbound,
  };
}

module.exports = {
  createBackendInboundService,
};
