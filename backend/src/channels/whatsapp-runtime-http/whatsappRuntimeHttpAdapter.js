function createRuntimeHttpError(code, message, retryable, statusCode, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = Boolean(retryable);
  error.statusCode = Number(statusCode) || 503;
  error.details = details;
  return error;
}

function toSafeTimeout(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1000, Math.min(60000, parsed));
}

function createWhatsappRuntimeHttpAdapter({
  runtimeBaseUrl,
  runtimeApiKey,
  logger,
  requestTimeoutMs = 15000,
}) {
  const baseUrl = String(runtimeBaseUrl || "").replace(/\/+$/, "");
  const timeoutMs = toSafeTimeout(requestTimeoutMs, 15000);

  function ensureConfigured() {
    if (!baseUrl) {
      throw createRuntimeHttpError(
        "RUNTIME_NOT_CONFIGURED",
        "External WhatsApp runtime base URL is not configured",
        false,
        503
      );
    }
    if (!runtimeApiKey) {
      throw createRuntimeHttpError(
        "RUNTIME_NOT_CONFIGURED",
        "External WhatsApp runtime API key is not configured",
        false,
        503
      );
    }
  }

  async function runtimeRequest(path, options = {}) {
    ensureConfigured();
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const effectiveTimeoutMs = toSafeTimeout(options.timeoutMs, timeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          "content-type": "application/json",
          "x-runtime-key": runtimeApiKey,
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const raw = await response.text();
      let payload = {};
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch (_parseError) {
          payload = {
            message: "Runtime returned a non-JSON response",
            raw,
          };
        }
      }

      if (!response.ok) {
        const retryable = payload.retryable !== false;
        throw createRuntimeHttpError(
          payload.errorCode || `HTTP_${response.status}`,
          payload.message || payload.error || `Runtime request failed: ${response.status}`,
          retryable,
          response.status,
          payload
        );
      }

      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw createRuntimeHttpError(
          "RUNTIME_REQUEST_TIMEOUT",
          `External runtime request timed out after ${effectiveTimeoutMs}ms`,
          true,
          504,
          {
            timeoutMs: effectiveTimeoutMs,
            path,
            method: options.method || "GET",
          }
        );
      }
      if (error && error.code && Object.prototype.hasOwnProperty.call(error, "retryable")) {
        throw error;
      }

      throw createRuntimeHttpError(
        "RUNTIME_REQUEST_FAILED",
        error && error.message ? error.message : "External runtime request failed",
        true,
        503,
        {
          path,
          method: options.method || "GET",
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendMessage({ restaurantId, to, text, metadata = {} }) {
    const payload = await runtimeRequest(
      `/runtime/v1/tenants/${encodeURIComponent(restaurantId)}/outbound/send`,
      {
        method: "POST",
        body: {
          outboxMessageId: String(metadata.outboxMessageId || "").trim(),
          channel: "whatsapp-web",
          to,
          text,
          messageType: String(metadata.messageType || metadata.type || "generic"),
          sourceAction: String(metadata.sourceAction || "unknown"),
          sourceRef: String(metadata.sourceRef || ""),
          attempt: Number(metadata.outboxAttempt || 0),
          metadata: metadata || {},
        },
      }
    );

    if (!payload.accepted) {
      throw createRuntimeHttpError(
        payload.errorCode || "RUNTIME_SEND_REJECTED",
        payload.message || "Runtime send rejected",
        payload.retryable !== false,
        503,
        payload
      );
    }

    if (payload.status === "in_flight") {
      throw createRuntimeHttpError(
        "RUNTIME_SEND_IN_FLIGHT",
        "Runtime is still processing this outbox message",
        true,
        503,
        payload
      );
    }

    logger.info("External runtime outbound accepted", {
      restaurantId,
      to,
      status: payload.status || "",
      deduped: Boolean(payload.deduped),
      handledByRuntimeInstance: payload.handledByRuntimeInstance || "",
    });

    return {
      providerMessageId: payload.providerMessageId || "",
      deduped: Boolean(payload.deduped),
      status: payload.status || "",
      handledByRuntimeInstance: payload.handledByRuntimeInstance || "",
      runtimeRequestTimeoutMs: timeoutMs,
    };
  }

  async function getSessionStatus({ restaurantId }) {
    const payload = await runtimeRequest(
      `/runtime/v1/tenants/${encodeURIComponent(restaurantId)}/status`,
      {
        method: "GET",
      }
    );

    if (!payload.tenant) {
      return {
        restaurantId,
        channel: "whatsapp-web",
        status: "unknown",
        runtimeOwner: "external-whatsapp-runtime",
      };
    }

    return {
      ...payload.tenant,
      channel: "whatsapp-web",
      runtimeOwner: "external-whatsapp-runtime",
      qrGeneratedAt: payload.tenant.lastQrAt || 0,
    };
  }

  async function startSession({ restaurantId }) {
    const payload = await runtimeRequest(
      `/runtime/v1/tenants/${encodeURIComponent(restaurantId)}/resume`,
      {
        method: "POST",
        body: {
          reason: "backend_session_start",
        },
      }
    );

    return payload.tenant || {
      restaurantId,
      channel: "whatsapp-web",
      status: "starting",
    };
  }

  async function disconnectSession({ restaurantId, reason }) {
    const payload = await runtimeRequest(
      `/runtime/v1/tenants/${encodeURIComponent(restaurantId)}/pause`,
      {
        method: "POST",
        body: {
          reason: String(reason || "backend_session_disconnect"),
        },
      }
    );

    return payload.tenant || {
      restaurantId,
      channel: "whatsapp-web",
      status: "paused",
    };
  }

  async function restartSession({ restaurantId, reason, requestTimeoutMs }) {
    const payload = await runtimeRequest(
      `/runtime/v1/tenants/${encodeURIComponent(restaurantId)}/restart`,
      {
        method: "POST",
        timeoutMs: requestTimeoutMs,
        body: {
          reason: String(reason || "backend_session_restart"),
        },
      }
    );

    return payload.tenant || {
      restaurantId,
      channel: "whatsapp-web",
      status: "starting",
    };
  }

  async function getEphemeralQr({ restaurantId }) {
    try {
      const payload = await runtimeRequest(
        `/runtime/v1/tenants/${encodeURIComponent(restaurantId)}/qr`,
        {
          method: "GET",
        }
      );
      return payload.qr || null;
    } catch (error) {
      if (error && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  function normalizeInboundMessage() {
    throw createRuntimeHttpError(
      "INBOUND_NOT_SUPPORTED",
      "External runtime adapter does not normalize direct inbound events in backend",
      false,
      400
    );
  }

  function setInboundHandler() {}

  return {
    channel: "whatsapp-web",
    sendMessage,
    getSessionStatus,
    startSession,
    disconnectSession,
    restartSession,
    getEphemeralQr,
    normalizeInboundMessage,
    setInboundHandler,
  };
}

module.exports = {
  createWhatsappRuntimeHttpAdapter,
  createRuntimeHttpError,
};
