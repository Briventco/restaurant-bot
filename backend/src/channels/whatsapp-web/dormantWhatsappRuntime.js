function createRuntimeDisabledError(message) {
  const error = new Error(message);
  error.code = "CHANNEL_RUNTIME_DISABLED";
  error.legacyCode = "WHATSAPP_RUNTIME_DISABLED";
  error.statusCode = 503;
  return error;
}

function createDormantWhatsappAdapter({ logger }) {
  return {
    channel: "whatsapp-web",
    normalizeInboundMessage: () => {
      throw createRuntimeDisabledError(
        "Backend internal WhatsApp runtime is disabled. Use whatsapp-bot as the transport runtime."
      );
    },
    sendMessage: async ({ restaurantId, to }) => {
      logger.warn("Skipped backend outbound WhatsApp send (runtime disabled)", {
        restaurantId,
        to,
      });
      throw createRuntimeDisabledError(
        "Backend internal WhatsApp runtime is disabled. Outbound delivery must go through whatsapp-bot."
      );
    },
    getSessionStatus: async ({ restaurantId }) => ({
      restaurantId,
      status: "disabled",
      runtimeOwner: "whatsapp-bot",
      qrAvailable: false,
      qrGeneratedAt: null,
      qrExpiresAt: null,
      runtimeDisabled: true,
    }),
    startSession: async ({ restaurantId }) => {
      throw createRuntimeDisabledError(
        `Backend internal WhatsApp runtime is disabled for ${restaurantId}. Start/manage session in whatsapp-bot.`
      );
    },
    disconnectSession: async ({ restaurantId }) => {
      logger.warn("Skipped backend WhatsApp disconnect (runtime disabled)", {
        restaurantId,
      });

      throw createRuntimeDisabledError(
        `Backend internal WhatsApp runtime is disabled for ${restaurantId}. Stop/manage session in whatsapp-bot.`
      );
    },
    restartSession: async ({ restaurantId }) => {
      logger.warn("Skipped backend WhatsApp restart (runtime disabled)", {
        restaurantId,
      });

      throw createRuntimeDisabledError(
        `Backend internal WhatsApp runtime is disabled for ${restaurantId}. Restart/manage session in whatsapp-bot.`
      );
    },
    getEphemeralQr: () => null,
    setInboundHandler: () => {},
  };
}

function createDormantWhatsappSessionService({ logger }) {
  return {
    async start(restaurantId) {
      logger.warn("Blocked backend WhatsApp session start (runtime disabled)", {
        restaurantId,
      });
      throw createRuntimeDisabledError(
        "Backend internal WhatsApp runtime is disabled. Start/manage session in whatsapp-bot."
      );
    },
    async getStatus(restaurantId) {
      return {
        restaurantId,
        status: "disabled",
        runtimeOwner: "whatsapp-bot",
        qrAvailable: false,
        qrGeneratedAt: null,
        qrExpiresAt: null,
        runtimeDisabled: true,
      };
    },
    async getQr() {
      return null;
    },
  };
}

module.exports = {
  createDormantWhatsappAdapter,
  createDormantWhatsappSessionService,
  createRuntimeDisabledError,
};
