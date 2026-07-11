function createFlutterwaveHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 503;
  return error;
}

function createFlutterwaveService({
  secretKey,
  baseUrl = "https://api.flutterwave.com/v3",
  requestTimeoutMs = 15000,
  logger,
}) {
  async function request(path, { method = "GET", body } = {}) {
    if (!secretKey) {
      throw createFlutterwaveHttpError("FLUTTERWAVE_SECRET_KEY is not configured", 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
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

      if (!response.ok || payload.status === "error") {
        const message =
          payload && payload.message
            ? payload.message
            : `Flutterwave request failed with status ${response.status}`;
        throw createFlutterwaveHttpError(message, response.status >= 400 ? response.status : 502);
      }

      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw createFlutterwaveHttpError(
          `Flutterwave request timed out after ${requestTimeoutMs}ms`,
          504
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initializeSubscriptionPayment({
    restaurantId,
    txRef,
    amount,
    currency = "NGN",
    customerEmail,
    customerName,
    customerPhone,
    redirectUrl,
    description,
  }) {
    const payload = await request("/payments", {
      method: "POST",
      body: {
        tx_ref: txRef,
        amount,
        currency,
        redirect_url: redirectUrl,
        customer: {
          email: customerEmail,
          name: customerName,
          phonenumber: customerPhone,
        },
        meta: {
          restaurantId,
          purpose: "servra_subscription",
        },
        customizations: {
          title: "Servra Subscription",
          description: description || "Servra restaurant bot subscription renewal",
        },
      },
    });

    const link = payload && payload.data && payload.data.link ? payload.data.link : "";
    if (!link) {
      throw createFlutterwaveHttpError("Flutterwave did not return a checkout link", 502);
    }

    logger && logger.info("Flutterwave payment initialized", { restaurantId, txRef });

    return { link, txRef };
  }

  async function verifyTransaction(transactionId) {
    const payload = await request(`/transactions/${encodeURIComponent(transactionId)}/verify`);
    return payload && payload.data ? payload.data : null;
  }

  return {
    isConfigured: Boolean(secretKey),
    initializeSubscriptionPayment,
    verifyTransaction,
  };
}

module.exports = {
  createFlutterwaveService,
};
