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

function buildHealthPayload() {
  return {
    ok: true,
    service: "backend",
    timestamp: new Date().toISOString(),
  };
}

function buildStatusPayload() {
  return {
    ok: true,
    service: "backend",
    nodeEnv: env.NODE_ENV,
    runtimeMode: resolveRuntimeMode(),
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

function createHealthRoutes() {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json(buildHealthPayload());
  });

  router.get("/status", (_req, res) => {
    res.status(200).json(buildStatusPayload());
  });

  return router;
}

module.exports = {
  createHealthRoutes,
  buildHealthPayload,
  buildStatusPayload,
};
