const os = require("os");

const { createLogger } = require("../utils/logger");
const { loadTenantConfig } = require("./tenantConfigLoader");
const { createTenantRuntime, createRetryableError } = require("./tenantRuntime");

function createMultiTenantRuntimeManager({ constants }) {
  const logger = createLogger("whatsapp-bot:runtime");
  const config = loadTenantConfig(constants);
  const runtimeInstanceId = `${config.shardId}:${os.hostname()}:${process.pid}`;

  const tenantRuntimes = new Map();

  for (const tenant of config.tenants) {
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

  async function startEnabledTenants() {
    logger.info("Starting tenant runtimes", {
      mode: config.mode,
      shardId: config.shardId,
      runtimeInstanceId,
      tenantCount: config.tenants.length,
      enabledCount: config.tenants.filter((tenant) => tenant.enabled).length,
      maxTenantsPerProcess: config.maxTenantsPerProcess,
    });

    for (const runtime of tenantRuntimes.values()) {
      const snapshot = runtime.getStatusSnapshot();
      if (!snapshot.enabled) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await runtime.start("startup");
    }
  }

  async function shutdown() {
    logger.info("Stopping tenant runtimes", {
      runtimeInstanceId,
      tenantCount: tenantRuntimes.size,
    });

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
      shardId: config.shardId,
      mode: config.mode,
      runtimeInstanceId,
      sourceFile: config.sourceFile || "",
      maxTenantsPerProcess: config.maxTenantsPerProcess,
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
    config,
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
    sendOutbound,
  };
}

module.exports = {
  createMultiTenantRuntimeManager,
};
