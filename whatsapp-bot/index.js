require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { constants } = require("./src/config/constants");
const { createLogger } = require("./src/utils/logger");
const { createMultiTenantRuntimeManager } = require("./src/runtime/multiTenantRuntimeManager");
const { collectChromiumDiagnostics } = require("./src/client/chromiumDiagnostics");

const logger = createLogger("whatsapp-bot");
const runtimeManager = createMultiTenantRuntimeManager({ constants });

function resolveTenantRouteErrorStatus(error) {
  const code = String((error && error.code) || "").trim();
  if (code === "TENANT_NOT_FOUND") {
    return 404;
  }
  if (code === "INVALID_PAYLOAD") {
    return 400;
  }
  if (code === "TENANT_DISABLED" || code === "TENANT_PAUSED") {
    return 409;
  }
  if (error && error.retryable === false) {
    return 400;
  }
  return 503;
}

function buildRuntimeReadyState(summary) {
  if (!constants.BOT_ENABLED) {
    return {
      ready: false,
      reason: "bot_disabled",
    };
  }

  const statusCounts = summary && summary.counts ? summary.counts.byStatus || {} : {};
  const connectedCount = Number(statusCounts.connected || 0);

  if (connectedCount <= 0) {
    return {
      ready: false,
      reason: "no_connected_tenants",
    };
  }

  return {
    ready: true,
    reason: "ok",
  };
}

function createRuntimeAuthMiddleware() {
  return function runtimeAuthMiddleware(req, res, next) {
    if (!constants.BOT_RUNTIME_ADMIN_KEY) {
      res.status(503).json({
        error: "BOT_RUNTIME_ADMIN_KEY is not configured",
      });
      return;
    }

    const incoming = String(req.header("x-runtime-key") || "").trim();
    if (!incoming || incoming !== constants.BOT_RUNTIME_ADMIN_KEY) {
      res.status(401).json({ error: "Unauthorized runtime access" });
      return;
    }

    next();
  };
}

function buildHealthPayload(summary, readiness) {
  return {
    ok: readiness.ready,
    service: "whatsapp-bot",
    runtimeMode: constants.BOT_RUNTIME_MODE,
    shardId: summary.shardId,
    runtimeInstanceId: summary.runtimeInstanceId,
    runtimeReady: readiness.ready,
    reason: readiness.reason,
    counts: summary.counts,
    timestamp: new Date().toISOString(),
  };
}

function probeRoute(app, path, timeoutMs = 3000) {
  const { EventEmitter } = require("events");

  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = "GET";
    req.url = path;
    req.headers = {};
    req.connection = {};
    req.socket = {};
    req.get = (name) => req.headers[String(name).toLowerCase()];

    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    let body = "";
    let finished = false;

    const done = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({
        path,
        statusCode: 599,
        note: "probe_timeout",
      });
    }, timeoutMs);

    res.setHeader = (key, value) => {
      res.headers[String(key).toLowerCase()] = value;
    };
    res.getHeader = (key) => res.headers[String(key).toLowerCase()];
    res.removeHeader = (key) => {
      delete res.headers[String(key).toLowerCase()];
    };
    res.writeHead = (statusCode, headers) => {
      res.statusCode = statusCode;
      if (headers && typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }
      }
    };
    res.write = (chunk) => {
      if (chunk) {
        body += chunk.toString();
      }
      return true;
    };
    res.end = (chunk) => {
      clearTimeout(timer);
      if (chunk) {
        body += chunk.toString();
      }
      done({
        path,
        statusCode: res.statusCode,
        bodyPreview: body.slice(0, 120),
      });
    };

    app.handle(req, res, (error) => {
      clearTimeout(timer);
      done({
        path,
        statusCode: 598,
        note: "probe_next_called",
        error: error ? error.message || String(error) : "",
      });
    });
  });
}

async function logStartupRouteDiagnostics(app) {
  const probePaths = ["/", "/health", "/status"];
  const results = [];

  for (const path of probePaths) {
    // eslint-disable-next-line no-await-in-loop
    const result = await probeRoute(app, path);
    results.push(result);
  }

  console.log("RUNTIME_ROUTE_DIAGNOSTICS =", JSON.stringify(results));
}

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  const requireRuntimeKey = createRuntimeAuthMiddleware();
  const summaryBeforeStart = runtimeManager.getRuntimeSummary();
  const chromiumDiagnostics = collectChromiumDiagnostics(
    constants.PUPPETEER_EXECUTABLE_PATH
  );

  console.log("CHROMIUM_DIAGNOSTICS =", JSON.stringify(chromiumDiagnostics));

  if (
    constants.BOT_ENABLED &&
    Number(summaryBeforeStart.counts.enabled || 0) > 0 &&
    !chromiumDiagnostics.ok
  ) {
    logger.error("Chromium executable is not available for Puppeteer", {
      ...chromiumDiagnostics,
      hint:
        "Ensure build runs `npm install` (postinstall installs chrome) and do not set PUPPETEER_SKIP_DOWNLOAD=true.",
    });
    throw new Error(
      "Chromium is not available. Runtime cannot start enabled tenants."
    );
  }

  await runtimeManager.startEnabledTenants();

  app.get("/", (_req, res) => {
    const summary = runtimeManager.getRuntimeSummary();
    const readiness = buildRuntimeReadyState(summary);

    res.status(200).json({
      service: "whatsapp-bot",
      runtimeMode: constants.BOT_RUNTIME_MODE,
      shardId: summary.shardId,
      runtimeInstanceId: summary.runtimeInstanceId,
      runtimeReady: readiness.ready,
      reason: readiness.reason,
      counts: summary.counts,
    });
  });

  app.get("/health", (_req, res) => {
    const summary = runtimeManager.getRuntimeSummary();
    const readiness = buildRuntimeReadyState(summary);

    res.status(200).json(buildHealthPayload(summary, readiness));
  });

  app.get("/status", (_req, res) => {
    const summary = runtimeManager.getRuntimeSummary();
    const readiness = buildRuntimeReadyState(summary);

    res.status(200).json(buildHealthPayload(summary, readiness));
  });

  app.get("/runtime/v1/tenants", requireRuntimeKey, (_req, res) => {
    res.status(200).json(runtimeManager.getRuntimeSummary());
  });

  app.get("/runtime/v1/tenants/:restaurantId/status", requireRuntimeKey, (req, res) => {
    try {
      const tenant = runtimeManager.getTenantStatus(req.params.restaurantId);
      res.status(200).json({
        tenant,
      });
    } catch (error) {
      const statusCode = error.retryable === false ? 404 : 500;
      res.status(statusCode).json({
        error: error.message,
        code: error.code || "",
      });
    }
  });

  app.get("/runtime/v1/tenants/:restaurantId/qr", requireRuntimeKey, (req, res) => {
    try {
      const qr = runtimeManager.getTenantQr(req.params.restaurantId);
      if (!qr) {
        res.status(404).json({ error: "No active QR for tenant" });
        return;
      }
      res.status(200).json({ qr });
    } catch (error) {
      const statusCode = error.retryable === false ? 404 : 500;
      res.status(statusCode).json({
        error: error.message,
        code: error.code || "",
      });
    }
  });

  app.post("/runtime/v1/tenants/:restaurantId/pause", requireRuntimeKey, async (req, res) => {
    try {
      const tenant = await runtimeManager.pauseTenant(
        req.params.restaurantId,
        String((req.body && req.body.reason) || "").trim() || "manual_pause"
      );
      res.status(200).json({
        success: true,
        tenant,
      });
    } catch (error) {
      const statusCode = error.retryable === false ? 404 : 500;
      res.status(statusCode).json({
        error: error.message,
        code: error.code || "",
      });
    }
  });

  app.post("/runtime/v1/tenants/:restaurantId/resume", requireRuntimeKey, async (req, res) => {
    try {
      const tenant = await runtimeManager.resumeTenant(
        req.params.restaurantId,
        String((req.body && req.body.reason) || "").trim() || "manual_resume"
      );
      res.status(200).json({
        success: true,
        tenant,
      });
    } catch (error) {
      const statusCode = error.retryable === false ? 404 : 500;
      res.status(statusCode).json({
        error: error.message,
        code: error.code || "",
      });
    }
  });

  app.post("/runtime/v1/tenants/:restaurantId/restart", requireRuntimeKey, async (req, res) => {
    try {
      const tenant = await runtimeManager.restartTenant(
        req.params.restaurantId,
        String((req.body && req.body.reason) || "").trim() || "manual_restart"
      );
      res.status(200).json({
        success: true,
        tenant,
      });
    } catch (error) {
      const statusCode = error.retryable === false ? 404 : 500;
      res.status(statusCode).json({
        error: error.message,
        code: error.code || "",
      });
    }
  });

  app.post(
    "/runtime/v1/tenants/:restaurantId/outbound/send",
    requireRuntimeKey,
    async (req, res) => {
      const restaurantId = String(req.params.restaurantId || "").trim();
      const payload = req.body || {};

      try {
        const result = await runtimeManager.sendOutbound(restaurantId, payload);
        res.status(200).json({
          ...result,
          handledByRuntimeInstance: runtimeManager.runtimeInstanceId,
          runtimeSendTimeoutMs: constants.BOT_RUNTIME_SEND_TIMEOUT_MS,
        });
      } catch (error) {
        const retryable = error.retryable !== false;
        const statusCode = resolveTenantRouteErrorStatus(error);
        res.status(statusCode).json({
          accepted: false,
          retryable,
          errorCode: error.code || "RUNTIME_SEND_FAILED",
          message: error.message || "Failed to send outbound message",
          handledByRuntimeInstance: runtimeManager.runtimeInstanceId,
          tenantStatus: (() => {
            try {
              const snapshot = runtimeManager.getTenantStatus(restaurantId);
              return snapshot.status;
            } catch (_innerError) {
              return "unknown";
            }
          })(),
        });
      }
    }
  );

  app.use((error, _req, res, _next) => {
    logger.error("Unhandled runtime error", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: error.message || "Internal runtime error",
    });
  });

  console.log("BOOTING WHATSAPP RUNTIME");
  console.log(
    "RUNTIME_CONFIG =",
    JSON.stringify({
      runtimeMode: constants.BOT_RUNTIME_MODE,
      shardId: constants.BOT_SHARD_ID,
      maxTenantsPerProcess: constants.BOT_MAX_TENANTS_PER_PROCESS,
      backendApiBaseUrl: constants.BACKEND_API_BASE_URL,
      backendApiPrefix: constants.BACKEND_API_PREFIX,
      puppeteerHeadless: constants.PUPPETEER_HEADLESS,
      puppeteerExecutablePath:
        constants.PUPPETEER_EXECUTABLE_PATH || chromiumDiagnostics.executablePath || "",
      whatsappAuthDataPath: constants.WHATSAPP_AUTH_DATA_PATH,
      adminKeyConfigured: Boolean(constants.BOT_RUNTIME_ADMIN_KEY),
    })
  );
  console.log("RUNTIME_ROUTE_MAP = /, /health, /status, /runtime/v1/tenants/*");

  await logStartupRouteDiagnostics(app).catch((error) => {
    logger.error("Runtime route diagnostics failed", {
      message: error.message,
      stack: error.stack,
    });
  });

  const server = app.listen(constants.PORT, () => {
    const summary = runtimeManager.getRuntimeSummary();
    logger.info("Runtime server started", {
      port: constants.PORT,
      runtimeMode: constants.BOT_RUNTIME_MODE,
      shardId: summary.shardId,
      runtimeInstanceId: summary.runtimeInstanceId,
      tenantCount: summary.counts.total,
      enabledTenants: summary.counts.enabled,
      maxTenantsPerProcess: summary.maxTenantsPerProcess,
    });
  });

  async function gracefulShutdown(signal) {
    logger.warn("Shutdown signal received", { signal });
    server.close();
    await runtimeManager.shutdown();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });

  process.on("unhandledRejection", (error) => {
    logger.error("Unhandled promise rejection", {
      message: error && error.message ? error.message : String(error),
    });
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", {
      message: error && error.message ? error.message : String(error),
    });
  });
}

main().catch((error) => {
  logger.error("Failed to start runtime", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
