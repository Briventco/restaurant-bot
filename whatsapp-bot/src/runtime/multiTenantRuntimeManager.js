const os = require("os");

const { createLogger } = require("../utils/logger");
const { loadTenantConfig } = require("./tenantConfigLoader");
const { createTenantRuntime, createRetryableError } = require("./tenantRuntime");

function createMultiTenantRuntimeManager({ constants }) {
  const logger = createLogger("whatsapp-bot:runtime");
  const initialConfig = loadTenantConfig(constants);
  const runtimeInstanceId = `${initialConfig.shardId}:${os.hostname()}:${process.pid}`;
  const runtimeConfig = {
    ...initialConfig,
  };

  const tenantRuntimes = new Map();
  let tenantSyncTimer = null;
  let tenantSyncInProgress = false;

  for (const tenant of initialConfig.tenants) {
    const runtime = createTenantRuntime({
      tenantConfig: tenant,
      constants,
      runtimeInstanceId,
      parentLogger: createLogger(`whatsapp-bot:${tenant.restaurantId}`),
    });
    tenantRuntimes.set(tenant.restaurantId, runtime);
  }

  function listTenants() {
    return Array.from(tenantRuntimes.values()).map((runtime) => runtime.getStatusSnapshot());
  }

  function getTenantRuntimeOrThrow(restaurantId) {
    const normalized = String(restaurantId || "").trim();
    const runtime = tenantRuntimes.get(normalized);
    if (!runtime) {
      throw createRetryableError(
        "TENANT_NOT_FOUND",
        `Tenant not found: ${normalized}`,
        false
      );
    }
    return runtime;
  }

  function normalizeTenant(rawTenant = {}) {
    const restaurantId = String(rawTenant.restaurantId || "").trim();
    return {
      restaurantId,
      enabled: rawTenant.enabled !== false,
      disabledReason: String(rawTenant.disabledReason || "").trim(),
      whatsappClientId: String(
        rawTenant.whatsappClientId || `wa_${restaurantId || "tenant"}`
      ).trim(),
      backendApiBaseUrl: String(
        rawTenant.backendApiBaseUrl || constants.BACKEND_API_BASE_URL || ""
      )
        .trim()
        .replace(/\/+$/, ""),
      backendApiKey: String(rawTenant.backendApiKey || "").trim(),
      allowAllChats: Boolean(rawTenant.allowAllChats),
      allowedChatIds: Array.isArray(rawTenant.allowedChatIds)
        ? rawTenant.allowedChatIds.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      allowedPhonePrefixes: Array.isArray(rawTenant.allowedPhonePrefixes)
        ? rawTenant.allowedPhonePrefixes
            .map((item) => String(item || "").replace(/[^0-9]/g, ""))
            .filter(Boolean)
        : [],
      ignoreGroupChats:
        rawTenant.ignoreGroupChats === undefined
          ? true
          : Boolean(rawTenant.ignoreGroupChats),
      reconnect: {
        baseDelayMs:
          Number(rawTenant.reconnect && rawTenant.reconnect.baseDelayMs) || 5000,
        maxDelayMs:
          Number(rawTenant.reconnect && rawTenant.reconnect.maxDelayMs) || 120000,
        maxAttemptsBeforePause:
          Number(rawTenant.reconnect && rawTenant.reconnect.maxAttemptsBeforePause) || 20,
      },
    };
  }

  function tenantComparableConfig(tenant) {
    return JSON.stringify({
      restaurantId: tenant.restaurantId,
      enabled: tenant.enabled,
      disabledReason: tenant.disabledReason,
      whatsappClientId: tenant.whatsappClientId,
      backendApiBaseUrl: tenant.backendApiBaseUrl,
      backendApiKey: tenant.backendApiKey,
      allowAllChats: tenant.allowAllChats,
      allowedChatIds: tenant.allowedChatIds,
      allowedPhonePrefixes: tenant.allowedPhonePrefixes,
      ignoreGroupChats: tenant.ignoreGroupChats,
      reconnect: tenant.reconnect,
    });
  }

  async function addTenantRuntime(tenant, reason) {
    const runtime = createTenantRuntime({
      tenantConfig: tenant,
      constants,
      runtimeInstanceId,
      parentLogger: createLogger(`whatsapp-bot:${tenant.restaurantId}`),
    });
    tenantRuntimes.set(tenant.restaurantId, runtime);
    if (tenant.enabled) {
      await runtime.start(reason || "dynamic_add");
    }
  }

  async function removeTenantRuntime(restaurantId, reason) {
    const runtime = tenantRuntimes.get(restaurantId);
    if (!runtime) {
      return;
    }
    await runtime.stop(reason || "dynamic_remove");
    tenantRuntimes.delete(restaurantId);
  }

  function buildRegistryUrl() {
    const baseUrl = String(constants.BACKEND_API_BASE_URL || "").trim().replace(/\/+$/, "");
    const path = String(constants.BACKEND_RUNTIME_REGISTRY_PATH || "/api/v1/runtime/tenants")
      .trim()
      .replace(/^([^/])/, "/$1");
    const query = new URLSearchParams({
      shardId: String(runtimeConfig.shardId || constants.BOT_SHARD_ID || "wa-shard-default"),
      maxTenants: String(runtimeConfig.maxTenantsPerProcess || constants.BOT_MAX_TENANTS_PER_PROCESS || 5),
      shardIndex: String(Math.max(0, Number(constants.BOT_SHARD_INDEX || 0))),
      shardCount: String(Math.max(1, Number(constants.BOT_SHARD_COUNT || 1))),
    });
    return `${baseUrl}${path}?${query.toString()}`;
  }

  async function fetchRemoteTenantConfig() {
    if (!constants.BACKEND_RUNTIME_REGISTRY_ENABLED) {
      return null;
    }

    const registryKey = String(constants.BACKEND_RUNTIME_REGISTRY_KEY || "").trim();
    if (!registryKey) {
      logger.warn("Tenant registry sync skipped: BACKEND_RUNTIME_REGISTRY_KEY missing");
      return null;
    }

    const url = buildRegistryUrl();
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "x-runtime-key": registryKey,
      },
    });
    const payloadText = await response.text();
    const payload = payloadText ? JSON.parse(payloadText) : {};
    if (!response.ok) {
      throw new Error(
        `Tenant registry request failed: HTTP ${response.status} ${payload.error || ""}`.trim()
      );
    }

    const tenantsRaw = Array.isArray(payload.tenants) ? payload.tenants : [];
    const seen = new Set();
    const tenants = [];
    for (const tenantRaw of tenantsRaw) {
      const tenant = normalizeTenant(tenantRaw);
      if (!tenant.restaurantId || seen.has(tenant.restaurantId)) {
        continue;
      }
      seen.add(tenant.restaurantId);
      tenants.push(tenant);
    }

    return {
      shardId: String(payload.shardId || runtimeConfig.shardId || "wa-shard-default").trim(),
      maxTenantsPerProcess: Math.max(
        1,
        Math.min(5, Number(payload.maxTenantsPerProcess || runtimeConfig.maxTenantsPerProcess || 5))
      ),
      tenants,
    };
  }

  async function reconcileTenants(nextConfig, reason = "tenant_sync") {
    if (!nextConfig) {
      return;
    }

    runtimeConfig.shardId = nextConfig.shardId;
    runtimeConfig.maxTenantsPerProcess = nextConfig.maxTenantsPerProcess;
    runtimeConfig.tenants = Array.isArray(nextConfig.tenants) ? nextConfig.tenants : [];

    const desired = new Map(nextConfig.tenants.map((tenant) => [tenant.restaurantId, tenant]));
    const currentIds = Array.from(tenantRuntimes.keys());

    for (const restaurantId of currentIds) {
      if (!desired.has(restaurantId)) {
        // eslint-disable-next-line no-await-in-loop
        await removeTenantRuntime(restaurantId, `${reason}_removed`);
      }
    }

    for (const [restaurantId, nextTenant] of desired.entries()) {
      const currentRuntime = tenantRuntimes.get(restaurantId);
      if (!currentRuntime) {
        // eslint-disable-next-line no-await-in-loop
        await addTenantRuntime(nextTenant, `${reason}_added`);
        continue;
      }

      const currentTenantConfig = normalizeTenant(currentRuntime.tenantConfig || {});
      if (
        tenantComparableConfig(currentTenantConfig) !== tenantComparableConfig(nextTenant)
      ) {
        // eslint-disable-next-line no-await-in-loop
        await removeTenantRuntime(restaurantId, `${reason}_replaced`);
        // eslint-disable-next-line no-await-in-loop
        await addTenantRuntime(nextTenant, `${reason}_replaced`);
      }
    }
  }

  async function syncTenantsNow({ reason = "manual_sync" } = {}) {
    if (tenantSyncInProgress) {
      return;
    }

    tenantSyncInProgress = true;
    try {
      const remote = await fetchRemoteTenantConfig();
      if (remote) {
        await reconcileTenants(remote, reason);
      }
    } catch (error) {
      logger.warn("Tenant sync failed", {
        reason,
        message: error.message,
      });
    } finally {
      tenantSyncInProgress = false;
    }
  }

  async function startEnabledTenants() {
    logger.info("Starting tenant runtimes", {
      mode: runtimeConfig.mode,
      shardId: runtimeConfig.shardId,
      runtimeInstanceId,
      tenantCount: runtimeConfig.tenants.length,
      enabledCount: runtimeConfig.tenants.filter((tenant) => tenant.enabled).length,
      maxTenantsPerProcess: runtimeConfig.maxTenantsPerProcess,
    });

    for (const runtime of tenantRuntimes.values()) {
      const snapshot = runtime.getStatusSnapshot();
      if (!snapshot.enabled) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await runtime.start("startup");
    }

    await syncTenantsNow({ reason: "startup_sync" });

    const syncIntervalMs = Math.max(
      5000,
      Number(constants.BACKEND_TENANT_SYNC_INTERVAL_MS || 30000)
    );
    if (constants.BACKEND_RUNTIME_REGISTRY_ENABLED && !tenantSyncTimer) {
      tenantSyncTimer = setInterval(() => {
        void syncTenantsNow({ reason: "interval_sync" });
      }, syncIntervalMs);
      if (typeof tenantSyncTimer.unref === "function") {
        tenantSyncTimer.unref();
      }
    }
  }

  async function shutdown() {
    logger.info("Stopping tenant runtimes", {
      runtimeInstanceId,
      tenantCount: tenantRuntimes.size,
    });

    if (tenantSyncTimer) {
      clearInterval(tenantSyncTimer);
      tenantSyncTimer = null;
    }

    for (const runtime of tenantRuntimes.values()) {
      // eslint-disable-next-line no-await-in-loop
      await runtime.stop("shutdown");
    }
  }

  function getRuntimeSummary() {
    const statuses = listTenants();
    const attentionStatuses = new Set(["paused", "disconnected", "error", "disabled"]);
    const counts = statuses.reduce(
      (acc, tenant) => {
        acc.total += 1;
        acc.byStatus[tenant.status] = (acc.byStatus[tenant.status] || 0) + 1;
        if (attentionStatuses.has(String(tenant.status || ""))) {
          acc.needsAttention += 1;
        }
        if (tenant.enabled) {
          acc.enabled += 1;
        } else {
          acc.disabled += 1;
        }
        return acc;
      },
      {
        total: 0,
        enabled: 0,
        disabled: 0,
        needsAttention: 0,
        byStatus: {},
      }
    );

    return {
      shardId: runtimeConfig.shardId,
      mode: runtimeConfig.mode,
      runtimeInstanceId,
      sourceFile: runtimeConfig.sourceFile || "",
      maxTenantsPerProcess: runtimeConfig.maxTenantsPerProcess,
      counts,
      tenants: statuses,
    };
  }

  async function pauseTenant(restaurantId, reason) {
    const runtime = getTenantRuntimeOrThrow(restaurantId);
    await runtime.pause(reason || "manual_pause");
    return runtime.getStatusSnapshot();
  }

  async function resumeTenant(restaurantId, reason) {
    const runtime = getTenantRuntimeOrThrow(restaurantId);
    await runtime.resume(reason || "manual_resume");
    return runtime.getStatusSnapshot();
  }

  async function restartTenant(restaurantId, reason) {
    const runtime = getTenantRuntimeOrThrow(restaurantId);
    await runtime.restart(reason || "manual_restart");
    return runtime.getStatusSnapshot();
  }

  function getTenantStatus(restaurantId) {
    const runtime = getTenantRuntimeOrThrow(restaurantId);
    return runtime.getStatusSnapshot();
  }

  function getTenantQr(restaurantId) {
    const runtime = getTenantRuntimeOrThrow(restaurantId);
    return runtime.getQr();
  }

  function getTenantDiagnostics(restaurantId) {
    const runtime = getTenantRuntimeOrThrow(restaurantId);
    return runtime.getDiagnostics();
  }

  function listTenantDiagnostics() {
    const diagnostics = {};
    for (const [restaurantId, runtime] of tenantRuntimes.entries()) {
      diagnostics[restaurantId] = runtime.getDiagnostics();
    }
    return diagnostics;
  }

  async function sendOutbound(restaurantId, payload) {
    const runtime = getTenantRuntimeOrThrow(restaurantId);
    return runtime.sendOutbound(payload);
  }

  return {
    config: runtimeConfig,
    runtimeInstanceId,
    startEnabledTenants,
    shutdown,
    listTenants,
    getRuntimeSummary,
    getTenantStatus,
    getTenantQr,
    getTenantDiagnostics,
    listTenantDiagnostics,
    pauseTenant,
    resumeTenant,
    restartTenant,
    syncTenantsNow,
    sendOutbound,
  };
}

module.exports = {
  createMultiTenantRuntimeManager,
};
