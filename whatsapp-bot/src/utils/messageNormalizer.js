function normalizePhoneFromChatId(chatId = "") {
  const base = String(chatId).split("@")[0] || "";
  const digits = base.replace(/[^0-9]/g, "");

  if (!digits) {
    return "";
  }

  return `+${digits}`;
}

function normalizeInboundMessage(rawMessage) {
  const from = rawMessage && rawMessage.from ? rawMessage.from : "";
  const body = rawMessage && rawMessage.body ? String(rawMessage.body) : "";
  const type = rawMessage && rawMessage.type ? String(rawMessage.type) : "";
  const messageId =
    (rawMessage && rawMessage.id && rawMessage.id._serialized) ||
    (rawMessage && rawMessage.id && rawMessage.id.id) ||
    "";

  const timestamp =
    rawMessage && rawMessage.timestamp
      ? Number(rawMessage.timestamp)
      : Math.floor(Date.now() / 1000);

  const isStatus = from === "status@broadcast";
  const isBroadcast = String(from).endsWith("@broadcast") || Boolean(rawMessage && rawMessage.broadcast);
  const isGroup = String(from).endsWith("@g.us");
  const customerPhone = normalizePhoneFromChatId(from);
  const customerPhoneDigits = customerPhone.replace(/[^0-9]/g, "");

  return {
    rawMessage,
    channel: "whatsapp-web",
    chatId: from,
    from,
    channelCustomerId: from,
    customerPhone,
    customerPhoneDigits,
    displayName: (rawMessage && (rawMessage.notifyName || rawMessage.author)) || "",
    body,
    messageId,
    timestamp,
    isFromMe: Boolean(rawMessage && rawMessage.fromMe),
    isStatus,
    isBroadcast,
    isGroup,
    type,
  };
}

module.exports = {
  normalizeInboundMessage,
  normalizePhoneFromChatId,
};
