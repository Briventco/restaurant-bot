const { sanitizePhoneFromWhatsappId } = require("../../domain/utils/text");

function normalizeInboundMessage(rawEvent) {
  const channelCustomerId = rawEvent.from || "";

  return {
    providerMessageId:
      (rawEvent.id && rawEvent.id._serialized) ||
      (rawEvent.id && rawEvent.id.id) ||
      "",
    channel: "whatsapp-web",
    channelCustomerId,
    customerPhone: sanitizePhoneFromWhatsappId(channelCustomerId),
    displayName: rawEvent.notifyName || "",
    text: rawEvent.body || "",
    timestamp: rawEvent.timestamp || Date.now(),
  };
}

module.exports = {
  normalizeInboundMessage,
};
