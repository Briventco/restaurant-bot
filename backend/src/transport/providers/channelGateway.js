const DEFAULT_CHANNEL = "whatsapp-web";

function createChannelGateway({ providerRegistry, sessionRepo, logger }) {
  function getChannel(inputChannel) {
    return String(inputChannel || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  }

  function getAdapter(channel) {
    return providerRegistry.getAdapter(getChannel(channel));
  }

  function normalizeInboundMessage({ channel, rawEvent }) {
    const normalizedChannel = getChannel(channel);
    const adapter = getAdapter(normalizedChannel);

    if (typeof adapter.normalizeInboundMessage !== "function") {
      const error = new Error(
        `Channel ${normalizedChannel} does not support inbound normalization`
      );
      error.statusCode = 400;
      throw error;
    }

    return adapter.normalizeInboundMessage(rawEvent);
  }

  async function sendMessage({ channel, restaurantId, to, text, metadata }) {
    const normalizedChannel = getChannel(channel);
    const adapter = getAdapter(normalizedChannel);

    return adapter.sendMessage({
      restaurantId,
      to,
      text,
      metadata: metadata || {},
    });
  }

  async function markSessionConnected({ channel, restaurantId, metadata }) {
    const normalizedChannel = getChannel(channel);
    return sessionRepo.upsertSession(restaurantId, normalizedChannel, {
      status: "connected",
      lastConnectedAt: new Date().toISOString(),
      lastError: "",
      ...(metadata || {}),
    });
  }

  async function disconnectSession({ channel, restaurantId, reason }) {
    const normalizedChannel = getChannel(channel);
    const adapter = getAdapter(normalizedChannel);

    if (typeof adapter.disconnectSession === "function") {
      try {
        await adapter.disconnectSession({ restaurantId, reason: reason || "" });
      } catch (error) {
        logger.warn("Provider disconnect call failed", {
          channel: normalizedChannel,
          restaurantId,
          message: error.message,
        });
      }
    }

    return sessionRepo.upsertSession(restaurantId, normalizedChannel, {
      status: "disconnected",
      lastDisconnectedAt: new Date().toISOString(),
      lastError: reason || "",
      qrAvailable: false,
    });
  }

  async function startSession({ channel, restaurantId }) {
    const normalizedChannel = getChannel(channel);
    const adapter = getAdapter(normalizedChannel);

    if (typeof adapter.startSession !== "function") {
      const error = new Error(`Channel ${normalizedChannel} does not support session start`);
      error.statusCode = 400;
      throw error;
    }

    return adapter.startSession({ restaurantId });
  }

  async function getConnectionStatus({ channel, restaurantId }) {
    const normalizedChannel = getChannel(channel);
    const adapter = getAdapter(normalizedChannel);

    if (typeof adapter.getSessionStatus === "function") {
      return adapter.getSessionStatus({ restaurantId });
    }

    const stored = await sessionRepo.getSession(restaurantId, normalizedChannel);
    return (
      stored || {
        restaurantId,
        channel: normalizedChannel,
        status: "disconnected",
        qrAvailable: false,
        qrGeneratedAt: null,
        qrExpiresAt: null,
      }
    );
  }

  async function restartSession({ channel, restaurantId, reason, requestTimeoutMs }) {
    const normalizedChannel = getChannel(channel);
    const adapter = getAdapter(normalizedChannel);

    if (typeof adapter.restartSession === "function") {
      return adapter.restartSession({ restaurantId, reason, requestTimeoutMs });
    }

    if (typeof adapter.disconnectSession !== "function" || typeof adapter.startSession !== "function") {
      const error = new Error(
        `Channel ${normalizedChannel} does not support session restart`
      );
      error.statusCode = 400;
      throw error;
    }

    await adapter.disconnectSession({ restaurantId, reason: reason || "restart" });
    return adapter.startSession({ restaurantId });
  }

  function getEphemeralQr({ channel, restaurantId, includeImage }) {
    const normalizedChannel = getChannel(channel);
    const adapter = getAdapter(normalizedChannel);

    if (typeof adapter.getEphemeralQr !== "function") {
      return null;
    }

    return adapter.getEphemeralQr({
      restaurantId,
      includeImage: Boolean(includeImage),
    });
  }

  return {
    sendMessage,
    normalizeInboundMessage,
    markSessionConnected,
    disconnectSession,
    startSession,
    getConnectionStatus,
    restartSession,
    getEphemeralQr,
  };
}

module.exports = {
  createChannelGateway,
};
