const { Client, LocalAuth } = require("whatsapp-web.js");

function sanitizeClientId(restaurantId) {
  return String(restaurantId).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function createWhatsappClientRegistry({
  sessionRepo,
  logger,
  qrTtlSeconds,
  onInboundMessage,
}) {
  const clients = new Map();
  const qrCache = new Map();

  async function setSessionState(restaurantId, patch) {
    try {
      await sessionRepo.upsertSession(restaurantId, "whatsapp-web", patch);
    } catch (error) {
      logger.error("Failed to update WhatsApp session state", {
        restaurantId,
        message: error.message,
      });
    }
  }

  function setQrCache(restaurantId, qr) {
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + qrTtlSeconds * 1000);

    qrCache.set(restaurantId, {
      qr,
      generatedAt,
      expiresAt,
    });

    void setSessionState(restaurantId, {
      status: "qr_required",
      qrAvailable: true,
      qrGeneratedAt: generatedAt.toISOString(),
      qrExpiresAt: expiresAt.toISOString(),
      lastError: "",
    });
  }

  function clearQrCache(restaurantId) {
    qrCache.delete(restaurantId);
    void setSessionState(restaurantId, {
      qrAvailable: false,
    });
  }

  function bindClientEvents(restaurantId, client) {
    client.on("qr", (qr) => {
      logger.info("WhatsApp QR generated", { restaurantId });
      setQrCache(restaurantId, qr);
    });

    client.on("authenticated", () => {
      logger.info("WhatsApp authenticated", { restaurantId });
      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "authenticating",
      });
    });

    client.on("ready", () => {
      logger.info("WhatsApp connected", { restaurantId });
      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "connected",
        qrAvailable: false,
        lastConnectedAt: new Date().toISOString(),
        lastError: "",
      });
    });

    client.on("disconnected", (reason) => {
      logger.warn("WhatsApp disconnected", {
        restaurantId,
        reason,
      });

      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: reason || "",
      });
    });

    client.on("auth_failure", (message) => {
      logger.error("WhatsApp auth failure", {
        restaurantId,
        message,
      });

      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastError: message || "auth_failure",
      });
    });

    client.on("message", async (message) => {
      if (typeof onInboundMessage !== "function") {
        return;
      }

      try {
        await onInboundMessage({
          restaurantId,
          message,
        });
      } catch (error) {
        logger.error("Inbound WhatsApp message handler failed", {
          restaurantId,
          message: error.message,
        });
      }
    });
  }

  async function startSession(restaurantId) {
    const existing = clients.get(restaurantId);
    if (existing) {
      return getSessionStatus(restaurantId);
    }

    await setSessionState(restaurantId, {
      status: "starting",
      qrAvailable: false,
      qrGeneratedAt: null,
      qrExpiresAt: null,
    });

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `restaurant_${sanitizeClientId(restaurantId)}`,
      }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    bindClientEvents(restaurantId, client);
    clients.set(restaurantId, { client });

    await client.initialize();

    return getSessionStatus(restaurantId);
  }

  async function sendMessage({ restaurantId, to, text }) {
    let entry = clients.get(restaurantId);
    if (!entry) {
      await startSession(restaurantId);
      entry = clients.get(restaurantId);
    }

    if (!entry) {
      throw new Error("Failed to initialize WhatsApp client");
    }

    await entry.client.sendMessage(to, text);
  }

  async function disconnectSession(restaurantId) {
    const entry = clients.get(restaurantId);
    if (!entry) {
      await setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: "",
      });
      return;
    }

    try {
      await entry.client.destroy();
    } finally {
      clients.delete(restaurantId);
      clearQrCache(restaurantId);
      await setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: "",
      });
    }
  }

  function getCurrentQr(restaurantId) {
    const record = qrCache.get(restaurantId);
    if (!record) {
      return null;
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      qrCache.delete(restaurantId);
      void setSessionState(restaurantId, {
        qrAvailable: false,
      });
      return null;
    }

    return {
      qr: record.qr,
      generatedAt: record.generatedAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  async function getSessionStatus(restaurantId) {
    const stored = await sessionRepo.getSession(restaurantId, "whatsapp-web");
    const qr = getCurrentQr(restaurantId);

    if (!stored) {
      return {
        restaurantId,
        status: "disconnected",
        qrAvailable: Boolean(qr),
        qrGeneratedAt: qr ? qr.generatedAt : null,
        qrExpiresAt: qr ? qr.expiresAt : null,
      };
    }

    return {
      ...stored,
      qrAvailable: Boolean(qr),
      qrGeneratedAt: qr ? qr.generatedAt : stored.qrGeneratedAt || null,
      qrExpiresAt: qr ? qr.expiresAt : stored.qrExpiresAt || null,
    };
  }

  return {
    startSession,
    sendMessage,
    disconnectSession,
    getSessionStatus,
    getCurrentQr,
  };
}

module.exports = {
  createWhatsappClientRegistry,
};
