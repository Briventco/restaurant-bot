const dotenv = require("dotenv");

dotenv.config();

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: toNumber(process.env.PORT, 3002),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  BACKEND_DEFAULT_RESTAURANT_ID:
    process.env.BACKEND_DEFAULT_RESTAURANT_ID || "",
  WHATSAPP_QR_TTL_SECONDS: toNumber(
    process.env.WHATSAPP_QR_TTL_SECONDS,
    120
  ),
  INBOUND_MENU_COOLDOWN_SECONDS: toNumber(
    process.env.INBOUND_MENU_COOLDOWN_SECONDS,
    90
  ),
  BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME: toBoolean(
    process.env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME,
    false
  ),
  BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME: toBoolean(
    process.env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME,
    false
  ),
  WHATSAPP_RUNTIME_BASE_URL: process.env.WHATSAPP_RUNTIME_BASE_URL || "",
  WHATSAPP_RUNTIME_API_KEY: process.env.WHATSAPP_RUNTIME_API_KEY || "",
  WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS: toNumber(
    process.env.WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS,
    15000
  ),
  OUTBOX_INLINE_SEND_ENABLED: toBoolean(
    process.env.OUTBOX_INLINE_SEND_ENABLED,
    true
  ),
  OUTBOX_WORKER_ENABLED: toBoolean(
    process.env.OUTBOX_WORKER_ENABLED,
    false
  ),
  OUTBOX_WORKER_POLL_MS: toNumber(
    process.env.OUTBOX_WORKER_POLL_MS,
    1500
  ),
  OUTBOX_WORKER_BATCH_SIZE: toNumber(
    process.env.OUTBOX_WORKER_BATCH_SIZE,
    5
  ),
  OUTBOX_LEASE_MS: toNumber(
    process.env.OUTBOX_LEASE_MS,
    30000
  ),
  OUTBOX_MAX_ATTEMPTS: toNumber(
    process.env.OUTBOX_MAX_ATTEMPTS,
    5
  ),
  OUTBOX_RETRY_BASE_MS: toNumber(
    process.env.OUTBOX_RETRY_BASE_MS,
    1000
  ),
  OUTBOX_RETRY_MAX_MS: toNumber(
    process.env.OUTBOX_RETRY_MAX_MS,
    60000
  ),
};

module.exports = {
  env,
};
