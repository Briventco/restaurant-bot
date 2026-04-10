function createMetaHttpError(code, message, retryable, statusCode, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = Boolean(retryable);
  error.statusCode = Number(statusCode) || 503;
  error.details = details;
  return error;
}

function normalizeBaseUrl(version) {
  const normalizedVersion = String(version || "v22.0").trim() || "v22.0";
  return `https://graph.facebook.com/${normalizedVersion}`;
}

function createWhatsappMetaAdapter({
  accessToken,
  phoneNumberId,
  wabaId,
  logger,
  channel = "whatsapp-web",
  apiVersion = "v22.0",
  requestTimeoutMs = 15000,
  resolveConfigForRestaurant,
}) {
  const baseUrl = normalizeBaseUrl(apiVersion);

  function ensureConfigured(config = {}) {
    const effectiveAccessToken = config.accessToken || accessToken;
    const effectivePhoneNumberId = config.phoneNumberId || phoneNumberId;

    if (!effectiveAccessToken) {
      throw createMetaHttpError(
        "META_NOT_CONFIGURED",
        "META_ACCESS_TOKEN is required for Meta WhatsApp provider",
        false,
        503
      );
    }

    if (!effectivePhoneNumberId) {
      throw createMetaHttpError(
        "META_NOT_CONFIGURED",
        "META_PHONE_NUMBER_ID is required for Meta WhatsApp provider",
        false,
        503
      );
    }
  }

  async function resolveRestaurantConfig(restaurantId) {
    if (typeof resolveConfigForRestaurant !== "function") {
      return {
        configured: true,
        provider: "meta-whatsapp-cloud-api",
        accessToken,
        phoneNumberId,
        wabaId,
        setupMessage: "",
      };
    }

    const resolved = await resolveConfigForRestaurant({ restaurantId });
    return resolved || {
      configured: false,
      provider: "",
      accessToken: "",
      phoneNumberId: "",
      wabaId: "",
      setupMessage: "No WhatsApp line has been assigned to this restaurant yet.",
    };
  }

  async function metaRequest(path, body, config = {}) {
    ensureConfigured(config);

    const effectiveAccessToken = config.accessToken || accessToken;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${effectiveAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
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
        const metaError = payload && payload.error ? payload.error : {};
        throw createMetaHttpError(
          String(metaError.code || `HTTP_${response.status}`),
          metaError.message || `Meta request failed with status ${response.status}`,
          response.status >= 500,
          response.status,
          payload
        );
      }

      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw createMetaHttpError(
          "META_REQUEST_TIMEOUT",
          `Meta request timed out after ${requestTimeoutMs}ms`,
          true,
          504
        );
      }

      if (error && error.code) {
        throw error;
      }

      throw createMetaHttpError(
        "META_REQUEST_FAILED",
        error && error.message ? error.message : "Meta request failed",
        true,
        503
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendMessage({ restaurantId, to, text }) {
    const config = await resolveRestaurantConfig(restaurantId);
    if (!config.configured || config.provider !== "meta-whatsapp-cloud-api") {
      throw createMetaHttpError(
        "META_NOT_CONFIGURED",
        config.setupMessage ||
          `Restaurant ${restaurantId} does not have a Meta WhatsApp line configured yet`,
        false,
        503
      );
    }

    const normalizedTo = String(to || "").replace(/[^0-9]/g, "");
    const normalizedText = String(text || "").trim();

    if (!normalizedTo) {
      throw createMetaHttpError("INVALID_RECIPIENT", "Recipient is required", false, 400);
    }
    if (!normalizedText) {
      throw createMetaHttpError("INVALID_TEXT", "Text is required", false, 400);
    }

    const effectivePhoneNumberId = config.phoneNumberId || phoneNumberId;

    const payload = await metaRequest(`/${effectivePhoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "text",
      text: {
        body: normalizedText,
      },
    }, config);

    logger.info("Meta outbound send accepted", {
      restaurantId,
      to: normalizedTo,
      phoneNumberId: effectivePhoneNumberId,
      messageId:
        payload &&
        Array.isArray(payload.messages) &&
        payload.messages[0] &&
        payload.messages[0].id
          ? payload.messages[0].id
          : "",
    });

    return {
      providerMessageId:
        payload &&
        Array.isArray(payload.messages) &&
        payload.messages[0] &&
        payload.messages[0].id
          ? payload.messages[0].id
          : "",
      channel,
      provider: "meta-whatsapp-cloud-api",
    };
  }

  async function getSessionStatus({ restaurantId }) {
    const config = await resolveRestaurantConfig(restaurantId);
    if (!config.configured || config.provider !== "meta-whatsapp-cloud-api") {
      return {
        restaurantId,
        channel,
        status: "not_configured",
        runtimeOwner: "meta-whatsapp-cloud-api",
        qrAvailable: false,
        qrGeneratedAt: null,
        qrExpiresAt: null,
        phoneNumberId: "",
        wabaId: "",
        configured: false,
        setupMessage:
          config.setupMessage || "No Meta WhatsApp line has been configured for this restaurant yet.",
      };
    }

    return {
      restaurantId,
      channel,
      status: "connected",
      runtimeOwner: "meta-whatsapp-cloud-api",
      qrAvailable: false,
      qrGeneratedAt: null,
      qrExpiresAt: null,
      phone: config.phone || "",
      phoneNumberId: config.phoneNumberId || phoneNumberId,
      wabaId: config.wabaId || wabaId,
      configured: true,
      setupMessage: config.setupMessage || "",
    };
  }

  async function startSession({ restaurantId }) {
    return getSessionStatus({ restaurantId });
  }

  async function disconnectSession({ restaurantId }) {
    logger.warn("Meta provider does not support QR-style disconnect session operations", {
      restaurantId,
      channel,
    });
    return getSessionStatus({ restaurantId });
  }

  async function restartSession({ restaurantId }) {
    logger.warn("Meta provider does not support QR-style restart session operations", {
      restaurantId,
      channel,
    });
    return getSessionStatus({ restaurantId });
  }

  function getEphemeralQr() {
    return null;
  }

  function setInboundHandler() {}

  return {
    channel,
    sendMessage,
    getSessionStatus,
    startSession,
    disconnectSession,
    restartSession,
    getEphemeralQr,
    setInboundHandler,
  };
}

module.exports = {
  createWhatsappMetaAdapter,
  createMetaHttpError,
};
