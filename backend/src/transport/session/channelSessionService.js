const DEFAULT_CHANNEL = "whatsapp-web";

function createChannelSessionService({ channelGateway }) {
  function normalizeChannel(channel) {
    return String(channel || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  }

  async function start({ channel, restaurantId }) {
    return channelGateway.startSession({
      channel: normalizeChannel(channel),
      restaurantId,
    });
  }

  async function getStatus({ channel, restaurantId }) {
    return channelGateway.getConnectionStatus({
      channel: normalizeChannel(channel),
      restaurantId,
    });
  }

  async function getQr({ channel, restaurantId, includeImage = false }) {
    return channelGateway.getEphemeralQr({
      channel: normalizeChannel(channel),
      restaurantId,
      includeImage,
    });
  }

  async function disconnect({ channel, restaurantId, reason }) {
    return channelGateway.disconnectSession({
      channel: normalizeChannel(channel),
      restaurantId,
      reason,
    });
  }

  async function restart({ channel, restaurantId, reason, requestTimeoutMs }) {
    return channelGateway.restartSession({
      channel: normalizeChannel(channel),
      restaurantId,
      reason,
      requestTimeoutMs,
    });
  }

  return {
    start,
    getStatus,
    getQr,
    disconnect,
    restart,
  };
}

module.exports = {
  createChannelSessionService,
};
