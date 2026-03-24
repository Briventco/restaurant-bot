function normalizeText(value = "") {
  return String(value).trim().toLowerCase();
}

function sanitizePhoneFromWhatsappId(channelCustomerId = "") {
  const base = String(channelCustomerId).split("@")[0] || "";
  if (!base) {
    return "";
  }

  if (base.startsWith("+")) {
    return base;
  }

  return `+${base.replace(/[^0-9]/g, "")}`;
}

module.exports = {
  normalizeText,
  sanitizePhoneFromWhatsappId,
};
