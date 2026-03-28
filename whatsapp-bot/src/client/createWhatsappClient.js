const { Client, LocalAuth } = require("whatsapp-web.js");

function createWhatsappClient({ clientId, protocolTimeoutMs, puppeteerArgs }) {
  return new Client({
    authStrategy: new LocalAuth({
      clientId,
    }),
    puppeteer: {
      headless: true,
      protocolTimeout: protocolTimeoutMs,
      args: puppeteerArgs,
    },
  });
}

module.exports = {
  createWhatsappClient,
};
