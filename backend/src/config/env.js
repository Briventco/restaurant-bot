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

function toStringArray(value, fallback = []) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: toNumber(process.env.PORT, 3002),
  WHATSAPP_PROVIDER: process.env.WHATSAPP_PROVIDER || "webjs",
  WHATSAPP_BROWSER_EXECUTABLE_PATH:
    process.env.WHATSAPP_BROWSER_EXECUTABLE_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_EXECUTABLE_PATH ||
    "",
  LLM_PROVIDER: process.env.LLM_PROVIDER || "openai",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-5-mini",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-2.0-flash",
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
  WHATSAPP_RESTORE_SESSIONS_ON_BOOT: toBoolean(
    process.env.WHATSAPP_RESTORE_SESSIONS_ON_BOOT,
    true
  ),
  WHATSAPP_RESTORE_SESSION_LIMIT: toNumber(
    process.env.WHATSAPP_RESTORE_SESSION_LIMIT,
    25
  ),
  WHATSAPP_RUNTIME_BASE_URL: process.env.WHATSAPP_RUNTIME_BASE_URL || "",
  WHATSAPP_RUNTIME_API_KEY: process.env.WHATSAPP_RUNTIME_API_KEY || "",
  WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS: toNumber(
    process.env.WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS,
    15000
  ),
  BACKEND_RUNTIME_REGISTRY_KEY:
    process.env.BACKEND_RUNTIME_REGISTRY_KEY ||
    process.env.WHATSAPP_RUNTIME_API_KEY ||
    "",
  BACKEND_RUNTIME_PUBLIC_BASE_URL:
    process.env.BACKEND_RUNTIME_PUBLIC_BASE_URL || "",
  META_WEBHOOK_ENABLED: toBoolean(
    process.env.META_WEBHOOK_ENABLED,
    false
  ),
  META_API_VERSION: process.env.META_API_VERSION || "v22.0",
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || "",
  META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID || "",
  META_WABA_ID: process.env.META_WABA_ID || "",
  META_WEBHOOK_PATH: process.env.META_WEBHOOK_PATH || "/webhooks/meta/whatsapp",
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || "",
  META_WEBHOOK_DEFAULT_RESTAURANT_ID:
    process.env.META_WEBHOOK_DEFAULT_RESTAURANT_ID || "",
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
  LLM_REQUEST_TIMEOUT_MS: toNumber(
    process.env.LLM_REQUEST_TIMEOUT_MS,
    15000
  ),
  RESTAURANT_HEALTH_MONITOR_ENABLED: toBoolean(
    process.env.RESTAURANT_HEALTH_MONITOR_ENABLED,
    true
  ),
  RESTAURANT_HEALTH_MONITOR_INTERVAL_MS: toNumber(
    process.env.RESTAURANT_HEALTH_MONITOR_INTERVAL_MS,
    300000
  ),
  RESTAURANT_HEALTH_DEGRADE_CONSECUTIVE_CHECKS: toNumber(
    process.env.RESTAURANT_HEALTH_DEGRADE_CONSECUTIVE_CHECKS,
    2
  ),
  RESTAURANT_HEALTH_RECOVERY_CONSECUTIVE_CHECKS: toNumber(
    process.env.RESTAURANT_HEALTH_RECOVERY_CONSECUTIVE_CHECKS,
    2
  ),
  RESTAURANT_HEALTH_MANUAL_OVERRIDE_MS: toNumber(
    process.env.RESTAURANT_HEALTH_MANUAL_OVERRIDE_MS,
    900000
  ),
  RESTAURANT_HEALTH_ALERT_WEBHOOK_URL:
    process.env.RESTAURANT_HEALTH_ALERT_WEBHOOK_URL || "",
  RESTAURANT_ACTIVATION_MONITOR_ENABLED: toBoolean(
    process.env.RESTAURANT_ACTIVATION_MONITOR_ENABLED,
    true
  ),
  RESTAURANT_ACTIVATION_MONITOR_INTERVAL_MS: toNumber(
    process.env.RESTAURANT_ACTIVATION_MONITOR_INTERVAL_MS,
    15000
  ),
  CORS_ALLOWED_ORIGINS: toStringArray(process.env.CORS_ALLOWED_ORIGINS, [
    "http://localhost:5173",
    "http://localhost:4173",
  ]),
};

module.exports = {
  env,
};
