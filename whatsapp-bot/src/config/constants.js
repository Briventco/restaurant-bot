const path = require("node:path");

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function parseCsv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const configuredPuppeteerCacheDir = String(
  process.env.PUPPETEER_CACHE_DIR || ".cache/puppeteer"
).trim();
const normalizedPuppeteerCacheDir = path.isAbsolute(configuredPuppeteerCacheDir)
  ? configuredPuppeteerCacheDir
  : path.resolve(process.cwd(), configuredPuppeteerCacheDir);
process.env.PUPPETEER_CACHE_DIR = normalizedPuppeteerCacheDir;

const constants = {
  PORT: toNumber(process.env.PORT, 3001),
  BOT_RUNTIME_MODE: (process.env.BOT_RUNTIME_MODE || "single").trim().toLowerCase(),
  BOT_SHARD_ID: process.env.BOT_SHARD_ID || "wa-shard-default",
  BOT_MAX_TENANTS_PER_PROCESS: toNumber(
    process.env.BOT_MAX_TENANTS_PER_PROCESS,
    5
  ),
  BOT_TENANTS_FILE: process.env.BOT_TENANTS_FILE || "",
  BOT_RUNTIME_ADMIN_KEY: process.env.BOT_RUNTIME_ADMIN_KEY || "",
  BOT_RUNTIME_QR_TTL_MS: toNumber(process.env.BOT_RUNTIME_QR_TTL_MS, 120000),
  BOT_RUNTIME_HEARTBEAT_MS: toNumber(process.env.BOT_RUNTIME_HEARTBEAT_MS, 15000),
  BOT_RUNTIME_SEND_TIMEOUT_MS: toNumber(process.env.BOT_RUNTIME_SEND_TIMEOUT_MS, 12000),
  BOT_RUNTIME_OUTBOUND_INFLIGHT_TTL_MS: toNumber(
    process.env.BOT_RUNTIME_OUTBOUND_INFLIGHT_TTL_MS,
    90000
  ),
  BOT_RUNTIME_OUTBOUND_SENT_TTL_MS: toNumber(
    process.env.BOT_RUNTIME_OUTBOUND_SENT_TTL_MS,
    24 * 60 * 60 * 1000
  ),
  BOT_RUNTIME_OUTBOUND_FAILED_TTL_MS: toNumber(
    process.env.BOT_RUNTIME_OUTBOUND_FAILED_TTL_MS,
    30 * 60 * 1000
  ),
  WHATSAPP_CLIENT_ID: process.env.WHATSAPP_CLIENT_ID || "restaurant-bot",
  WHATSAPP_AUTH_DATA_PATH: process.env.WHATSAPP_AUTH_DATA_PATH || ".wwebjs_auth",
  BOT_ENABLED: toBoolean(process.env.BOT_ENABLED, true),
  BOT_RESTAURANT_ID: process.env.BOT_RESTAURANT_ID || "",
  BACKEND_API_BASE_URL: process.env.BACKEND_API_BASE_URL || "http://localhost:3002",
  BACKEND_API_PREFIX: process.env.BACKEND_API_PREFIX || "/api/v1",
  BACKEND_API_KEY: process.env.BACKEND_API_KEY || "",
  BACKEND_REQUEST_TIMEOUT_MS: toNumber(process.env.BACKEND_REQUEST_TIMEOUT_MS, 15000),
  PUPPETEER_PROTOCOL_TIMEOUT_MS: toNumber(
    process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS,
    180000
  ),
  PUPPETEER_HEADLESS: toBoolean(process.env.PUPPETEER_HEADLESS, true),
  PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || "",
  PUPPETEER_CACHE_DIR: normalizedPuppeteerCacheDir,
  PUPPETEER_ARGS: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
  SEND_DELAY_MS: toNumber(process.env.SEND_DELAY_MS, 250),
  SEND_RETRY_ATTEMPTS: toNumber(process.env.SEND_RETRY_ATTEMPTS, 1),
  SEND_RETRY_BACKOFF_MS: toNumber(process.env.SEND_RETRY_BACKOFF_MS, 800),
  INBOUND_DEDUPE_TTL_MS: toNumber(process.env.INBOUND_DEDUPE_TTL_MS, 5 * 60 * 1000),
  INBOUND_DEDUPE_MAX_ENTRIES: toNumber(process.env.INBOUND_DEDUPE_MAX_ENTRIES, 5000),
  OUTBOUND_DEDUPE_TTL_MS: toNumber(process.env.OUTBOUND_DEDUPE_TTL_MS, 5 * 60 * 1000),
  OUTBOUND_DEDUPE_MAX_ENTRIES: toNumber(process.env.OUTBOUND_DEDUPE_MAX_ENTRIES, 5000),
  SUPPORTED_INBOUND_TYPES: new Set(["chat", "text"]),
  IGNORE_BROADCAST: true,
  IGNORE_STATUS: true,
  IGNORE_FROM_ME: true,
  IGNORE_GROUP_CHATS: toBoolean(process.env.BOT_IGNORE_GROUP_CHATS, true),
  BOT_ALLOW_ALL_CHATS: toBoolean(process.env.BOT_ALLOW_ALL_CHATS, false),
  ALLOWED_CHAT_IDS: new Set(parseCsv(process.env.BOT_ALLOWED_CHAT_IDS)),
  ALLOWED_PHONE_PREFIXES: parseCsv(process.env.BOT_ALLOWED_PHONE_PREFIXES)
    .map((value) => value.replace(/[^0-9]/g, ""))
    .filter(Boolean),
};

module.exports = {
  constants,
};
