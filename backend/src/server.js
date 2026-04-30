const { createApp, API_BASE } = require("./app");
const { env } = require("./config/env");
const { runStartupChecks } = require("./config/startupChecks");
const logger = require("./infra/logger");

function isRecoverableRuntimeError(error) {
  const message = String((error && error.message) || "").toLowerCase();
  return (
    message.includes("execution context was destroyed") ||
    message.includes("runtime.callfunctionon timed out") ||
    message.includes("target closed") ||
    message.includes("protocol error")
  );
}

process.on("unhandledRejection", (reason) => {
  const message = String((reason && reason.message) || reason || "");
  if (isRecoverableRuntimeError({ message })) {
    logger.warn("Unhandled promise rejection (recoverable runtime error)", {
      message,
    });
    return;
  }
  logger.error("Unhandled promise rejection", {
    message,
    stack: reason && reason.stack ? reason.stack : "",
  });
});

process.on("uncaughtException", (error) => {
  if (isRecoverableRuntimeError(error)) {
    logger.warn("Uncaught exception (recoverable runtime error)", {
      message: error.message,
      stack: error.stack,
    });
    return;
  }
  logger.error("Uncaught exception", {
    message: error && error.message ? error.message : "unknown_uncaught_exception",
    stack: error && error.stack ? error.stack : "",
  });
  process.exit(1);
});
function probeRoute(app, path, timeoutMs = 4000) {
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
  const probePaths = ["/", "/test", `${API_BASE}/health`, `${API_BASE}/status`, "/health", "/status"];
  const results = [];

  for (const path of probePaths) {
    // eslint-disable-next-line no-await-in-loop
    const result = await probeRoute(app, path);
    results.push(result);
  }

  console.log("ROUTE_DIAGNOSTICS =", JSON.stringify(results));
}

runStartupChecks({ env, logger });
const app = createApp();
if (
  env.RESTAURANT_HEALTH_MONITOR_ENABLED &&
  app.locals &&
  app.locals.restaurantHealthService &&
  typeof app.locals.restaurantHealthService.startBackgroundMonitor === "function"
) {
  app.locals.restaurantHealthService.startBackgroundMonitor({
    intervalMs: env.RESTAURANT_HEALTH_MONITOR_INTERVAL_MS,
  });
}
if (
  env.RESTAURANT_ACTIVATION_MONITOR_ENABLED &&
  app.locals &&
  app.locals.restaurantActivationService &&
  typeof app.locals.restaurantActivationService.startBackgroundMonitor === "function"
) {
  app.locals.restaurantActivationService.startBackgroundMonitor({
    intervalMs: env.RESTAURANT_ACTIVATION_MONITOR_INTERVAL_MS,
  });
}
if (
  env.WHATSAPP_RESTORE_SESSIONS_ON_BOOT &&
  app.locals &&
  typeof app.locals.restoreWhatsappSessionsOnBoot === "function"
) {
  app.locals
    .restoreWhatsappSessionsOnBoot()
    .then((result) => {
      logger.info("WhatsApp session restore completed", result || {});
    })
    .catch((error) => {
      logger.warn("WhatsApp session restore failed", {
        message: error.message,
        stack: error.stack,
      });
    });
}

console.log("BOOTING RESTAURANT BACKEND APP");
console.log("API_BASE =", API_BASE);
console.log(
  "ROUTE_MAP =",
  ["/", "/test", `${API_BASE}/health`, `${API_BASE}/status`, "/health", "/status"].join(", ")
);

logStartupRouteDiagnostics(app)
  .catch((error) => {
    logger.error("Route diagnostics failed", {
      message: error.message,
      stack: error.stack,
    });
  })
  .finally(() => {
    app.listen(env.PORT, () => {
      logger.info("Backend service started", {
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
      });
    });
  });
