function toPositiveTimeout(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function isAuthenticatingTimedOut({
  status,
  authenticatedAt,
  now = Date.now(),
  timeoutMs,
}) {
  if (String(status || "") !== "authenticating") {
    return false;
  }

  const startedAt = Number(authenticatedAt || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return false;
  }

  const effectiveTimeoutMs = toPositiveTimeout(timeoutMs, 90000);
  return now - startedAt >= effectiveTimeoutMs;
}

module.exports = {
  isAuthenticatingTimedOut,
  toPositiveTimeout,
};
