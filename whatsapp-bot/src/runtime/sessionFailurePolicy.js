function normalizeReasonText(reason) {
  return String(reason || "").trim().toLowerCase();
}

function requiresManualReauthentication(reason) {
  const normalized = normalizeReasonText(reason);
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("logout") ||
    normalized.includes("log out") ||
    normalized.includes("logged out") ||
    normalized.includes("auth_failure") ||
    normalized.includes("auth failure") ||
    normalized.includes("authentication failure")
  );
}

module.exports = {
  normalizeReasonText,
  requiresManualReauthentication,
};
