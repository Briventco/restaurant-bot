const { Router } = require("express");

function toList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function toDigitsList(value) {
  return toList(value)
    .map((entry) => entry.replace(/[^0-9]/g, ""))
    .filter(Boolean);
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizeRestaurantAsTenant(restaurant, backendBaseUrl) {
  const restaurantId = String(
    (restaurant && (restaurant.id || restaurant.restaurantId)) || ""
  ).trim();
  const bot = restaurant && restaurant.bot && typeof restaurant.bot === "object" ? restaurant.bot : {};
  const whatsapp =
    restaurant && restaurant.whatsapp && typeof restaurant.whatsapp === "object"
      ? restaurant.whatsapp
      : {};
  const provider = String(whatsapp.provider || "").trim().toLowerCase();
  const provisioningState = String(whatsapp.provisioningState || "")
    .trim()
    .toLowerCase();

  const usesMetaProvider =
    provider === "meta" ||
    provider === "meta-whatsapp-cloud-api" ||
    provider === "whatsapp-cloud-api";
  const explicitlyUnassigned = provisioningState === "unassigned" && whatsapp.configured === false;
  const enabled = bot.enabled !== false && !usesMetaProvider;

  return {
    restaurantId,
    enabled,
    disabledReason: enabled
      ? ""
      : usesMetaProvider
        ? "meta_provider_managed_outside_runtime"
        : bot.enabled === false
          ? "bot_disabled"
          : explicitlyUnassigned
            ? "whatsapp_unassigned"
            : "runtime_disabled",
    whatsappClientId: `wa_${restaurantId}`,
    backendApiBaseUrl: backendBaseUrl,
    backendApiKey: "",
    allowAllChats: toBoolean(bot.allowAllChats, false),
    allowedChatIds: toList(bot.allowedChatIds),
    allowedPhonePrefixes: toDigitsList(bot.allowedPhonePrefixes),
    ignoreGroupChats: bot.ignoreGroupChats !== false,
    reconnect: {
      baseDelayMs: 5000,
      maxDelayMs: 120000,
      maxAttemptsBeforePause: 20,
    },
  };
}

function computeShardBucket(restaurantId, shardCount) {
  const safeId = String(restaurantId || "");
  let hash = 0;
  for (let index = 0; index < safeId.length; index += 1) {
    hash = (hash * 31 + safeId.charCodeAt(index)) >>> 0;
  }
  return hash % Math.max(1, shardCount);
}

function createRuntimeRegistryRoutes({ env, restaurantRepo, logger }) {
  const router = Router();

  router.get("/runtime/tenants", async (req, res, next) => {
    try {
      const configuredKey = String(env.BACKEND_RUNTIME_REGISTRY_KEY || "").trim();
      if (!configuredKey) {
        res.status(503).json({
          error: "Runtime registry key is not configured",
        });
        return;
      }

      const incomingKey = String(req.header("x-runtime-key") || "").trim();
      if (!incomingKey || incomingKey !== configuredKey) {
        res.status(401).json({
          error: "Unauthorized runtime registry access",
        });
        return;
      }

      const shardId = String(req.query.shardId || "").trim() || "wa-shard-default";
      const shardCount = Math.max(1, Number(req.query.shardCount || 1) || 1);
      const shardIndex = Math.max(
        0,
        Math.min(shardCount - 1, Number(req.query.shardIndex || 0) || 0)
      );
      const maxTenants = Math.max(
        1,
        Math.min(5, Number(req.query.maxTenants || 5) || 5)
      );
      const restaurants = await restaurantRepo.listRestaurants({ limit: 200 });
      const requestBaseUrl = `${req.protocol}://${req.get("host")}`;
      const backendBaseUrl = String(env.BACKEND_RUNTIME_PUBLIC_BASE_URL || requestBaseUrl)
        .trim()
        .replace(/\/+$/, "");

      const candidates = restaurants
        .map((restaurant) => normalizeRestaurantAsTenant(restaurant, backendBaseUrl))
        .filter((tenant) => Boolean(tenant.restaurantId))
        .filter(
          (tenant) => computeShardBucket(tenant.restaurantId, shardCount) === shardIndex
        )
        .sort((left, right) => left.restaurantId.localeCompare(right.restaurantId));

      const selected = candidates.slice(0, maxTenants);
      logger.info("Runtime tenant registry requested", {
        shardId,
        requestedMaxTenants: maxTenants,
        shardCount,
        shardIndex,
        totalCandidates: candidates.length,
        selectedCount: selected.length,
      });

      res.status(200).json({
        version: 1,
        shardId,
        maxTenantsPerProcess: maxTenants,
        tenants: selected,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createRuntimeRegistryRoutes,
};
