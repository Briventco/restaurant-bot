function shouldIgnoreNormalizedMessage(message, constants) {
  if (!message) {
    return { ignore: true, reason: "missing_message" };
  }

  if (constants.IGNORE_STATUS && message.isStatus) {
    return { ignore: true, reason: "status_broadcast" };
  }

  if (constants.IGNORE_BROADCAST && message.isBroadcast) {
    return { ignore: true, reason: "broadcast" };
  }

  if (constants.IGNORE_FROM_ME && message.isFromMe) {
    return { ignore: true, reason: "from_me" };
  }

  if (constants.IGNORE_GROUP_CHATS && message.isGroup) {
    return { ignore: true, reason: "group_chat" };
  }

  if (message.type && !constants.SUPPORTED_INBOUND_TYPES.has(message.type)) {
    return { ignore: true, reason: `unsupported_type:${message.type}` };
  }

  if (!String(message.body || "").trim()) {
    return { ignore: true, reason: "empty_body" };
  }

  if (!String(message.chatId || "").trim()) {
    return { ignore: true, reason: "missing_chat_id" };
  }

  // Detect staff commands (messages starting with #)
  const trimmedBody = String(message.body || "").trim();
  if (trimmedBody.startsWith('#')) {
    return { ignore: false, reason: "staff_command", isStaffCommand: true };
  }

  if (!constants.BOT_ALLOW_ALL_CHATS) {
    const hasChatAllowlist =
      constants.ALLOWED_CHAT_IDS && constants.ALLOWED_CHAT_IDS.size > 0;
    const hasPrefixAllowlist =
      Array.isArray(constants.ALLOWED_PHONE_PREFIXES) &&
      constants.ALLOWED_PHONE_PREFIXES.length > 0;

    if (!hasChatAllowlist && !hasPrefixAllowlist) {
      return { ignore: true, reason: "no_allowlist_configured" };
    }
  }

  if (
    constants.ALLOWED_CHAT_IDS &&
    constants.ALLOWED_CHAT_IDS.size > 0 &&
    !constants.ALLOWED_CHAT_IDS.has(message.chatId)
  ) {
    return { ignore: true, reason: "chat_not_allowlisted" };
  }

  if (
    Array.isArray(constants.ALLOWED_PHONE_PREFIXES) &&
    constants.ALLOWED_PHONE_PREFIXES.length > 0
  ) {
    const phoneDigits = String(message.customerPhoneDigits || "");
    const matched = constants.ALLOWED_PHONE_PREFIXES.some((prefix) =>
      phoneDigits.startsWith(prefix)
    );

    if (!matched) {
      return { ignore: true, reason: "phone_prefix_not_allowlisted" };
    }
  }

  return { ignore: false, reason: "ok" };
}

module.exports = {
  shouldIgnoreNormalizedMessage,
};
