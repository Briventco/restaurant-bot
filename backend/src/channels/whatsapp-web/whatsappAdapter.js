const { normalizeInboundMessage } = require("./whatsappEventMapper");
const { createWhatsappClientRegistry } = require("./whatsappClientRegistry");

function createWhatsappAdapter({
  sessionRepo,
  logger,
  qrTtlSeconds,
  browserExecutablePath,
}) {
  let inboundHandler = null;

  const clientRegistry = createWhatsappClientRegistry({
    sessionRepo,
    logger,
    qrTtlSeconds,
    browserExecutablePath,
    onInboundMessage: async ({ restaurantId, message }) => {
      if (!inboundHandler) {
        return;
      }

      await inboundHandler({
        restaurantId,
        channel: "whatsapp-web",
        rawEvent: message,
      });
    },
  });

  function setInboundHandler(handler) {
    inboundHandler = handler;
  }

  async function sendMessage({ restaurantId, to, text }) {
    return clientRegistry.sendMessage({ restaurantId, to, text });
  }

  async function getSessionStatus({ restaurantId }) {
    return clientRegistry.getSessionStatus(restaurantId);
  }

  async function startSession({ restaurantId }) {
    return clientRegistry.startSession(restaurantId);
  }

  async function disconnectSession({ restaurantId }) {
    return clientRegistry.disconnectSession(restaurantId);
  }

  async function restartSession({ restaurantId }) {
    await clientRegistry.disconnectSession(restaurantId);
    return clientRegistry.startSession(restaurantId);
  }

  function getEphemeralQr({ restaurantId }) {
    return clientRegistry.getCurrentQr(restaurantId);
  }

  return {
    channel: "whatsapp-web",
    normalizeInboundMessage,
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
  createWhatsappAdapter,
};
