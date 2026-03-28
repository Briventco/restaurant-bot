const fs = require("fs");
const path = require("path");

function toStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function toDigitsList(value) {
  return toStringList(value)
    .map((entry) => entry.replace(/[^0-9]/g, ""))
    .filter(Boolean);
}

function normalizeTenant(input = {}, index = 0) {
  const restaurantId = String(input.restaurantId || "").trim();
  const whatsappClientId = String(
    input.whatsappClientId || `restaurant-${restaurantId || index + 1}`
  ).trim();

  return {
    restaurantId,
    enabled: input.enabled !== false,
    disabledReason: String(input.disabledReason || "").trim(),
    whatsappClientId,
    backendApiBaseUrl: String(input.backendApiBaseUrl || "").trim(),
    backendApiKey: String(input.backendApiKey || "").trim(),
    allowAllChats: Boolean(input.allowAllChats),
    allowedChatIds: toStringList(input.allowedChatIds),
    allowedPhonePrefixes: toDigitsList(input.allowedPhonePrefixes),
    ignoreGroupChats:
      input.ignoreGroupChats === undefined ? true : Boolean(input.ignoreGroupChats),
    reconnect: {
      baseDelayMs: Number(input.reconnect && input.reconnect.baseDelayMs) || 5000,
      maxDelayMs: Number(input.reconnect && input.reconnect.maxDelayMs) || 120000,
      maxAttemptsBeforePause:
        Number(input.reconnect && input.reconnect.maxAttemptsBeforePause) || 20,
    },
  };
}

function validateTenant(tenant) {
  if (!tenant.restaurantId) {
    throw new Error("Tenant restaurantId is required");
  }
  if (!tenant.whatsappClientId) {
    throw new Error(`Tenant ${tenant.restaurantId} whatsappClientId is required`);
  }
  if (!tenant.backendApiBaseUrl) {
    throw new Error(`Tenant ${tenant.restaurantId} backendApiBaseUrl is required`);
  }
  if (!tenant.backendApiKey) {
    throw new Error(`Tenant ${tenant.restaurantId} backendApiKey is required`);
  }
}

function enforceUniqueness(tenants) {
  const restaurantIds = new Set();
  const clientIds = new Set();

  for (const tenant of tenants) {
    if (restaurantIds.has(tenant.restaurantId)) {
      throw new Error(`Duplicate tenant restaurantId: ${tenant.restaurantId}`);
    }
    restaurantIds.add(tenant.restaurantId);

    if (clientIds.has(tenant.whatsappClientId)) {
      throw new Error(`Duplicate tenant whatsappClientId: ${tenant.whatsappClientId}`);
    }
    clientIds.add(tenant.whatsappClientId);
  }
}

function loadSingleTenantConfig(constants) {
  const runtimeReady =
    constants.BOT_ENABLED &&
    constants.BOT_RESTAURANT_ID &&
    constants.BACKEND_API_KEY &&
    constants.BACKEND_API_BASE_URL;

  const tenant = normalizeTenant(
    {
      restaurantId: constants.BOT_RESTAURANT_ID || "",
      enabled: runtimeReady,
      disabledReason: runtimeReady ? "" : "single_tenant_runtime_not_ready",
      whatsappClientId: constants.WHATSAPP_CLIENT_ID,
      backendApiBaseUrl: constants.BACKEND_API_BASE_URL,
      backendApiKey: constants.BACKEND_API_KEY,
      allowAllChats: constants.BOT_ALLOW_ALL_CHATS,
      allowedChatIds: Array.from(constants.ALLOWED_CHAT_IDS || []),
      allowedPhonePrefixes: constants.ALLOWED_PHONE_PREFIXES || [],
      ignoreGroupChats: constants.IGNORE_GROUP_CHATS,
      reconnect: {
        baseDelayMs: 5000,
        maxDelayMs: 120000,
        maxAttemptsBeforePause: 20,
      },
    },
    0
  );

  if (tenant.enabled) {
    validateTenant(tenant);
  }

  return {
    version: 1,
    shardId: constants.BOT_SHARD_ID,
    maxTenantsPerProcess: constants.BOT_MAX_TENANTS_PER_PROCESS,
    tenants: [tenant],
    mode: "single",
  };
}

function loadMultiTenantConfig(constants) {
  const filePath = String(constants.BOT_TENANTS_FILE || "").trim();
  if (!filePath) {
    throw new Error("BOT_TENANTS_FILE is required when BOT_RUNTIME_MODE=multi");
  }

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Tenant config file not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw);
  const tenantsRaw = Array.isArray(parsed.tenants) ? parsed.tenants : [];
  const tenants = tenantsRaw.map((tenant, index) => normalizeTenant(tenant, index));

  enforceUniqueness(tenants);

  const enabledTenants = tenants.filter((tenant) => tenant.enabled);
  for (const tenant of enabledTenants) {
    validateTenant(tenant);
  }

  const fileCap = Number(parsed.maxTenantsPerProcess) || constants.BOT_MAX_TENANTS_PER_PROCESS;
  const effectiveCap = Math.max(1, Math.min(5, fileCap));

  if (enabledTenants.length > effectiveCap) {
    throw new Error(
      `Enabled tenant count ${enabledTenants.length} exceeds cap ${effectiveCap}`
    );
  }

  return {
    version: Number(parsed.version) || 1,
    shardId: String(parsed.shardId || constants.BOT_SHARD_ID || "wa-shard-default").trim(),
    maxTenantsPerProcess: effectiveCap,
    tenants,
    mode: "multi",
    sourceFile: absolutePath,
  };
}

function loadTenantConfig(constants) {
  const mode = String(constants.BOT_RUNTIME_MODE || "single").trim().toLowerCase();
  if (mode === "multi") {
    return loadMultiTenantConfig(constants);
  }
  return loadSingleTenantConfig(constants);
}

module.exports = {
  loadTenantConfig,
};
