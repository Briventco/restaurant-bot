const { sanitizePhoneFromWhatsappId } = require("../../domain/utils/text");

function isStatusBroadcastId(value) {
  return String(value || "").trim().toLowerCase() === "status@broadcast";
}

function detectStatusReply(rawEvent) {
  const data = (rawEvent && rawEvent._data) || {};
  return (
    isStatusBroadcastId(data.quotedRemoteJid) ||
    isStatusBroadcastId(data.remoteJid) ||
    isStatusBroadcastId(data.participant) ||
    isStatusBroadcastId(data.quotedParticipant) ||
    isStatusBroadcastId(data.author)
  );
}

function normalizeInboundMessage(rawEvent) {
  const channelCustomerId = rawEvent.from || "";
  const remoteFromId =
    (rawEvent && rawEvent.id && (rawEvent.id.remote || rawEvent.id.remoteJid)) || "";
  const statusLike =
    Boolean(rawEvent && (rawEvent.isStatus || rawEvent.isStatusV3)) ||
    isStatusBroadcastId(channelCustomerId) ||
    isStatusBroadcastId(rawEvent && rawEvent.to) ||
    isStatusBroadcastId(remoteFromId);
  const isStatusReply = detectStatusReply(rawEvent);
  const isBroadcast =
    Boolean(rawEvent && rawEvent.broadcast) ||
    (String(channelCustomerId || "").endsWith("@broadcast") &&
      !isStatusBroadcastId(channelCustomerId));

  const transcribedText = String(
    (rawEvent && rawEvent.__transcribedText) || ""
  ).trim();

  return {
    providerMessageId:
      (rawEvent.id && rawEvent.id._serialized) ||
      (rawEvent.id && rawEvent.id.id) ||
      "",
    channel: "whatsapp-web",
    channelCustomerId,
    customerPhone: sanitizePhoneFromWhatsappId(channelCustomerId),
    displayName: rawEvent.notifyName || "",
    text: transcribedText || rawEvent.body || "",
    timestamp: rawEvent.timestamp || Date.now(),
    isFromMe: Boolean(rawEvent.fromMe),
    isStatus: statusLike || isStatusReply,
    isBroadcast,
  };
}

module.exports = {
  normalizeInboundMessage,
};
