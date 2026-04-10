const { resolveWhatsappChannelStatus } = require("../../utils/whatsappChannelStatus");

function parseTimeValue(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

function buildIssue(code, label, severity, message) {
  return {
    code,
    key: String(code || "").trim().toLowerCase(),
    label,
    severity,
    message,
  };
}

function evaluateRestaurantHealth({
  restaurant,
  adminUser,
  menuItems = [],
  whatsapp = null,
}) {
  const issues = [];
  const safeRestaurant = restaurant && typeof restaurant === "object" ? restaurant : {};
  const availableMenuItems = (menuItems || []).filter((item) => item && item.available !== false);
  const bot = safeRestaurant.bot && typeof safeRestaurant.bot === "object" ? safeRestaurant.bot : {};
  const acceptsOrders = bot.enabled !== false;

  if (!adminUser || !String(adminUser.email || "").trim()) {
    issues.push(buildIssue("ADMIN_MISSING", "Admin account", "critical", "No restaurant admin account is assigned."));
  }

  if (acceptsOrders && !availableMenuItems.length) {
    issues.push(buildIssue("MENU_EMPTY", "Menu readiness", "critical", "No available menu items are currently live."));
  }

  if (!whatsapp || whatsapp.configured !== true) {
    issues.push(buildIssue("WHATSAPP_UNCONFIGURED", "WhatsApp", "critical", "WhatsApp is not configured for this restaurant."));
  } else if (String(whatsapp.status || "").trim().toLowerCase() !== "connected") {
    issues.push(buildIssue("WHATSAPP_DISCONNECTED", "WhatsApp", "degraded", "WhatsApp is configured but not currently connected."));
  }

  const name = String(safeRestaurant.name || "").trim();
  const phone = String(safeRestaurant.phone || "").trim();
  const address = String(safeRestaurant.address || "").trim();
  if (!name || !phone || !address) {
    issues.push(buildIssue("PROFILE_INCOMPLETE", "Restaurant profile", "warning", "Restaurant profile still has missing contact details."));
  }

  const openingHours = String(safeRestaurant.openingHours || "").trim();
  const closingHours = String(safeRestaurant.closingHours || "").trim();
  const openMinutes = parseTimeValue(openingHours);
  const closeMinutes = parseTimeValue(closingHours);
  if (!openingHours || !closingHours || openMinutes === null || closeMinutes === null || openMinutes === closeMinutes) {
    issues.push(buildIssue("HOURS_INVALID", "Operating hours", "warning", "Operating hours are missing or invalid."));
  }

  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const degradedCount = issues.filter((issue) => issue.severity === "degraded").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;

  let status = "healthy";
  if (criticalCount > 0) {
    status = "critical";
  } else if (degradedCount > 0 || warningCount > 0) {
    status = "degraded";
  }

  return {
    status,
    issues,
    summary: {
      criticalCount,
      degradedCount,
      warningCount,
      issueCount: issues.length,
    },
    isOperational: criticalCount === 0,
    checkedAt: new Date().toISOString(),
  };
}

function toEpochMs(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getNextConsecutiveCount(previousStatus, nextStatus, previousCount) {
  return previousStatus === nextStatus ? Number(previousCount || 0) + 1 : 1;
}

function buildHealthMetrics(previous, evaluation) {
  const previousStatus = previous ? String(previous.status || "").trim().toLowerCase() : "";
  return {
    consecutiveHealthyChecks:
      evaluation.status === "healthy"
        ? getNextConsecutiveCount(previousStatus, "healthy", previous && previous.metrics ? previous.metrics.consecutiveHealthyChecks : 0)
        : 0,
    consecutiveDegradedChecks:
      evaluation.status === "degraded"
        ? getNextConsecutiveCount(previousStatus, "degraded", previous && previous.metrics ? previous.metrics.consecutiveDegradedChecks : 0)
        : 0,
    consecutiveCriticalChecks:
      evaluation.status === "critical"
        ? getNextConsecutiveCount(previousStatus, "critical", previous && previous.metrics ? previous.metrics.consecutiveCriticalChecks : 0)
        : 0,
    lastEvaluatedStatus: evaluation.status,
  };
}

function getRuntimeLifecyclePolicy({
  currentActivationState,
  healthStatus,
  previousHealth,
  metrics,
  activation,
  source,
  env,
}) {
  const current = String(currentActivationState || "").trim().toLowerCase();
  const health = String(healthStatus || "").trim().toLowerCase();
  const now = Date.now();
  const manualOverrideUntil = activation && activation.manualOverrideUntil
    ? toEpochMs(activation.manualOverrideUntil)
    : 0;
  const overrideActive = source === "background_sweep" && manualOverrideUntil > now;
  const degradeThreshold = Math.max(1, Number(env.RESTAURANT_HEALTH_DEGRADE_CONSECUTIVE_CHECKS) || 2);
  const recoveryThreshold = Math.max(1, Number(env.RESTAURANT_HEALTH_RECOVERY_CONSECUTIVE_CHECKS) || 2);

  if (overrideActive) {
    return {
      shouldUpdate: false,
      nextState: current || "draft",
      reason: "Manual override window is still active.",
      code: "MANUAL_OVERRIDE_ACTIVE",
    };
  }

  if (
    current === "active" &&
    (health === "critical" || health === "degraded") &&
    (
      (health === "critical" && metrics.consecutiveCriticalChecks >= degradeThreshold) ||
      (health === "degraded" && metrics.consecutiveDegradedChecks >= degradeThreshold)
    )
  ) {
    return {
      shouldUpdate: true,
      nextState: "degraded",
      reason: `Restaurant auto-moved to degraded because runtime health stayed ${health} across ${health === "critical" ? metrics.consecutiveCriticalChecks : metrics.consecutiveDegradedChecks} checks.`,
      code: "AUTO_DEGRADE",
    };
  }

  if (
    current === "degraded" &&
    health === "healthy" &&
    metrics.consecutiveHealthyChecks >= recoveryThreshold
  ) {
    return {
      shouldUpdate: true,
      nextState: "active",
      reason: `Restaurant auto-recovered to active after ${metrics.consecutiveHealthyChecks} healthy checks.`,
      code: "AUTO_RECOVER",
    };
  }

  return {
    shouldUpdate: false,
    nextState: current || "draft",
    reason: "",
    code: "NOOP",
  };
}

async function emitHealthAlert({
  logger,
  healthAlertService,
  restaurantId,
  restaurantName,
  previous,
  current,
  lifecyclePolicy,
}) {
  const previousStatus = previous ? String(previous.status || "").trim().toLowerCase() : "";
  const currentStatus = String(current.status || "").trim().toLowerCase();
  if (!currentStatus || previousStatus === currentStatus) {
    return;
  }

  const payload = {
    restaurantId,
    previousStatus: previousStatus || "unknown",
    currentStatus,
    issueCodes: Array.isArray(current.issues) ? current.issues.map((issue) => issue.code) : [],
    lifecyclePolicyCode: lifecyclePolicy.code,
  };

  if (healthAlertService && typeof healthAlertService.sendHealthTransitionAlert === "function") {
    await healthAlertService.sendHealthTransitionAlert({
      restaurantId,
      restaurantName,
      previousStatus: payload.previousStatus,
      currentStatus: payload.currentStatus,
      issueCodes: payload.issueCodes,
      lifecyclePolicyCode: payload.lifecyclePolicyCode,
    });
    return;
  }

  if (currentStatus === "critical") {
    logger.error("Restaurant health became critical", payload);
    return;
  }

  if (currentStatus === "degraded") {
    logger.warn("Restaurant health became degraded", payload);
    return;
  }

  if (currentStatus === "healthy") {
    logger.info("Restaurant health recovered", payload);
  }
}

function createRestaurantHealthService({
  restaurantRepo,
  userRepo,
  menuRepo,
  providerSessionRepo,
  restaurantHealthRepo,
  healthAlertService,
  env,
  logger,
}) {
  async function loadRestaurantHealthContext(restaurantId) {
    const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
    if (!restaurant) {
      return null;
    }

    const [users, menuItems, session] = await Promise.all([
      userRepo.listUsersByRestaurantId(restaurantId),
      menuRepo.listMenuItems(restaurantId),
      providerSessionRepo.getSession(restaurantId, "whatsapp-web"),
    ]);
    const adminUser =
      users.find((user) => user.role === "restaurant_admin") || users[0] || null;
    const whatsapp = resolveWhatsappChannelStatus({
      restaurant,
      restaurantId,
      session,
      env,
    });

    return {
      restaurant,
      adminUser,
      menuItems,
      whatsapp,
    };
  }

  async function evaluateAndPersistRestaurantHealth({
    restaurantId,
    source = "manual",
  }) {
    const context = await loadRestaurantHealthContext(restaurantId);
    if (!context) {
      return null;
    }

    const previous = await restaurantHealthRepo.getCurrentHealth(restaurantId);
    const evaluation = evaluateRestaurantHealth(context);
    const metrics = buildHealthMetrics(previous, evaluation);
    const lifecycleSync = getRuntimeLifecyclePolicy({
      currentActivationState:
        context.restaurant &&
        context.restaurant.activation &&
        typeof context.restaurant.activation === "object"
          ? context.restaurant.activation.state
          : "",
      healthStatus: evaluation.status,
      previousHealth: previous,
      metrics,
      activation: context.restaurant && context.restaurant.activation ? context.restaurant.activation : null,
      source,
      env,
    });

    let lifecycleUpdated = null;
    if (lifecycleSync.shouldUpdate) {
      lifecycleUpdated = await restaurantRepo.upsertRestaurant(restaurantId, {
        activation: {
          ...(context.restaurant.activation && typeof context.restaurant.activation === "object"
            ? context.restaurant.activation
            : {}),
          state: lifecycleSync.nextState,
          note: lifecycleSync.reason,
          updatedAt: new Date().toISOString(),
          updatedBy: "system:health-monitor",
          manualOverrideUntil: "",
        },
      });
    }

    const current = await restaurantHealthRepo.upsertCurrentHealth(restaurantId, {
      status: evaluation.status,
      issues: evaluation.issues,
      summary: evaluation.summary,
      metrics,
      checkedAt: evaluation.checkedAt,
      source,
      activationState:
        lifecycleUpdated &&
        lifecycleUpdated.activation &&
        typeof lifecycleUpdated.activation === "object"
          ? lifecycleUpdated.activation.state
          : context.restaurant &&
              context.restaurant.activation &&
              typeof context.restaurant.activation === "object"
            ? context.restaurant.activation.state
            : "",
      lifecycleSync: lifecycleSync.shouldUpdate
        ? {
            applied: true,
            nextState: lifecycleSync.nextState,
            reason: lifecycleSync.reason,
            code: lifecycleSync.code,
          }
        : {
            applied: false,
            nextState: "",
            reason: "",
            code: lifecycleSync.code,
          },
    });

    const previousStatus = previous ? String(previous.status || "").trim().toLowerCase() : "";
    await emitHealthAlert({
      logger,
      healthAlertService,
      restaurantId,
      restaurantName: context.restaurant && context.restaurant.name ? context.restaurant.name : "",
      previous,
      current,
      lifecyclePolicy: lifecycleSync,
    });

    if (previousStatus !== evaluation.status || lifecycleSync.shouldUpdate) {
      await restaurantHealthRepo.createHealthEvent(restaurantId, {
        previousStatus: previousStatus || "unknown",
        newStatus: evaluation.status,
        source,
        issues: evaluation.issues,
        summary: evaluation.summary,
        metrics,
        lifecycleSync: lifecycleSync.shouldUpdate
          ? {
              nextState: lifecycleSync.nextState,
              reason: lifecycleSync.reason,
              code: lifecycleSync.code,
            }
          : null,
      });
    }

    return current;
  }

  async function runHealthSweep({ source = "background_sweep" } = {}) {
    const restaurants = await restaurantRepo.listRestaurants({ limit: 200 });
    const targets = restaurants.filter((restaurant) => {
      const state =
        restaurant &&
        restaurant.activation &&
        typeof restaurant.activation === "object"
          ? String(restaurant.activation.state || "").trim().toLowerCase()
          : "";

      return state === "active" || state === "degraded" || state === "ready_for_activation";
    });

    const results = [];
    for (const restaurant of targets) {
      // eslint-disable-next-line no-await-in-loop
      const health = await evaluateAndPersistRestaurantHealth({
        restaurantId: restaurant.id,
        source,
      });
      if (health) {
        results.push(health);
      }
    }

    return results;
  }

  function startBackgroundMonitor({ intervalMs }) {
    const safeIntervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 5 * 60 * 1000;
    logger.info("Restaurant health monitor started", {
      intervalMs: safeIntervalMs,
    });

    const run = async () => {
      try {
        await runHealthSweep({ source: "background_sweep" });
      } catch (error) {
        logger.error("Restaurant health sweep failed", {
          message: error.message,
          stack: error.stack,
        });
      }
    };

    run();
    const timer = setInterval(run, safeIntervalMs);
    return () => clearInterval(timer);
  }

  return {
    evaluateRestaurantHealth,
    evaluateAndPersistRestaurantHealth,
    runHealthSweep,
    startBackgroundMonitor,
  };
}

module.exports = {
  createRestaurantHealthService,
  evaluateRestaurantHealth,
};
