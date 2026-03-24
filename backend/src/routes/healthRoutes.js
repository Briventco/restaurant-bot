const { Router } = require("express");
const { env } = require("../config/env");

function resolveRuntimeMode() {
  if (env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME) {
    return "internal";
  }
  if (env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME) {
    return "external";
  }
  return "disabled";
}

function createHealthRoutes() {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "backend",
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/status", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "backend",
      nodeEnv: env.NODE_ENV,
      runtimeMode: resolveRuntimeMode(),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = {
  createHealthRoutes,
};
