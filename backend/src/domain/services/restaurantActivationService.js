const {
  buildRestaurantActivationValidation,
  getAllowedLifecycleTransition,
} = require("./restaurantActivationValidationService");
const { resolveWhatsappChannelStatus } = require("../../utils/whatsappChannelStatus");

const ACTIVATION_STEPS = [
  "validate_readiness",
  "verify_whatsapp_provisioning",
  "verify_runtime_health",
  "mark_live",
];

function toIsoNow() {
  return new Date().toISOString();
}

function normalizeJobStatus(value, fallback = "pending") {
  return String(value || "").trim().toLowerCase() || fallback;
}

function normalizeStepHistory(stepHistory) {
  return Array.isArray(stepHistory) ? stepHistory : [];
}

async function loadActivationContext({
  restaurantId,
  restaurantRepo,
  userRepo,
  menuRepo,
  providerSessionRepo,
  env,
}) {
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

function buildStepHistoryEntry(stepKey, status, patch = {}) {
  const now = toIsoNow();
  return {
    step: stepKey,
    status,
    startedAt: status === "running" ? now : patch.startedAt || null,
    completedAt:
      status === "completed" || status === "failed" ? now : patch.completedAt || null,
    error: String(patch.error || "").trim(),
    blockers: Array.isArray(patch.blockers) ? patch.blockers : [],
    note: String(patch.note || "").trim(),
  };
}

function updateStepHistory(stepHistory, stepKey, status, patch = {}) {
  const safeHistory = normalizeStepHistory(stepHistory);
  const existingIndex = safeHistory.findIndex((entry) => entry && entry.step === stepKey);
  const existing = existingIndex >= 0 ? safeHistory[existingIndex] : null;
  const nextEntry = {
    ...(existing || buildStepHistoryEntry(stepKey, status)),
    ...patch,
    step: stepKey,
    status,
  };

  if (status === "running" && !nextEntry.startedAt) {
    nextEntry.startedAt = toIsoNow();
  }
  if ((status === "completed" || status === "failed") && !nextEntry.completedAt) {
    nextEntry.completedAt = toIsoNow();
  }

  const nextHistory = [...safeHistory];
  if (existingIndex >= 0) {
    nextHistory[existingIndex] = nextEntry;
  } else {
    nextHistory.push(nextEntry);
  }
  return nextHistory;
}

function buildRestaurantActivationPatch(restaurant, patch = {}) {
  return {
    activation: {
      ...(restaurant && restaurant.activation && typeof restaurant.activation === "object"
        ? restaurant.activation
        : {}),
      ...patch,
    },
  };
}

function createRestaurantActivationService({
  restaurantRepo,
  userRepo,
  menuRepo,
  providerSessionRepo,
  activationJobRepo,
  restaurantHealthService,
  env,
  logger,
}) {
  let monitorTimer = null;
  let monitorRunning = false;

  async function markJobFailed({ job, restaurant, currentStep, error, blockers = [] }) {
    const failureMessage = String(error || "Activation failed.").trim();

    if (restaurant) {
      await restaurantRepo.upsertRestaurant(
        job.restaurantId,
        buildRestaurantActivationPatch(restaurant, {
          state: "ready_for_activation",
          note: failureMessage,
          updatedAt: toIsoNow(),
          updatedBy: "system:activation-runner",
        })
      );
    }

    return activationJobRepo.updateActivationJob(job.id, {
      status: "failed",
      currentStep,
      retryable: true,
      error: failureMessage,
      blockers,
      failedAt: toIsoNow(),
      stepHistory: updateStepHistory(job.stepHistory, currentStep, "failed", {
        error: failureMessage,
        blockers,
      }),
    });
  }

  async function runActivationJob({ jobId }) {
    const job = await activationJobRepo.getActivationJobById(jobId);
    if (!job) {
      return null;
    }

    const initialStatus = normalizeJobStatus(job.status);
    if (!["pending", "running", "retrying"].includes(initialStatus)) {
      return job;
    }

    let activeJob = await activationJobRepo.updateActivationJob(job.id, {
      status: "running",
      currentStep: job.currentStep || "queued",
      startedAt: job.startedAt || toIsoNow(),
      retryable: false,
      error: "",
    });

    const context = await loadActivationContext({
      restaurantId: activeJob.restaurantId,
      restaurantRepo,
      userRepo,
      menuRepo,
      providerSessionRepo,
      env,
    });

    if (!context) {
      return activationJobRepo.updateActivationJob(job.id, {
        status: "failed",
        currentStep: "load_context",
        retryable: false,
        error: "Restaurant no longer exists.",
        failedAt: toIsoNow(),
      });
    }

    activeJob = await activationJobRepo.updateActivationJob(job.id, {
      currentStep: "validate_readiness",
      stepHistory: updateStepHistory(activeJob.stepHistory, "validate_readiness", "running"),
    });

    const validation = buildRestaurantActivationValidation({
      restaurant: context.restaurant,
      adminUser: context.adminUser,
      menuItems: context.menuItems,
      whatsapp: context.whatsapp,
    });
    const transition = getAllowedLifecycleTransition({
      currentState: "ready_for_activation",
      nextState: "active",
      validation,
    });

    if (!transition.allowed) {
      return markJobFailed({
        job: activeJob,
        restaurant: context.restaurant,
        currentStep: "validate_readiness",
        error: transition.message,
        blockers: transition.blockers || [],
      });
    }

    activeJob = await activationJobRepo.updateActivationJob(job.id, {
      currentStep: "verify_whatsapp_provisioning",
      blockers: [],
      stepHistory: updateStepHistory(
        updateStepHistory(activeJob.stepHistory, "validate_readiness", "completed"),
        "verify_whatsapp_provisioning",
        "running"
      ),
    });

    const provisioningState = String(context.whatsapp && context.whatsapp.provisioningState
      ? context.whatsapp.provisioningState
      : "")
      .trim()
      .toLowerCase();
    const activationReady = Boolean(context.whatsapp && context.whatsapp.activationReady);
    if (!activationReady) {
      return markJobFailed({
        job: activeJob,
        restaurant: context.restaurant,
        currentStep: "verify_whatsapp_provisioning",
        error:
          provisioningState
            ? `WhatsApp provisioning is still ${provisioningState}. It must reach verified or active before activation can continue.`
            : "WhatsApp provisioning must be verified before activation can continue.",
      });
    }

    activeJob = await activationJobRepo.updateActivationJob(job.id, {
      currentStep: "verify_runtime_health",
      blockers: [],
      stepHistory: updateStepHistory(
        updateStepHistory(activeJob.stepHistory, "verify_whatsapp_provisioning", "completed"),
        "verify_runtime_health",
        "running"
      ),
    });

    const health = restaurantHealthService
      ? await restaurantHealthService.evaluateAndPersistRestaurantHealth({
          restaurantId: activeJob.restaurantId,
          source: "activation_job",
        })
      : null;
    const healthStatus = String(health && health.status ? health.status : "")
      .trim()
      .toLowerCase();
    if (healthStatus && healthStatus === "critical") {
      return markJobFailed({
        job: activeJob,
        restaurant: context.restaurant,
        currentStep: "verify_runtime_health",
        error: "Runtime health must not be critical before go-live.",
      });
    }

    activeJob = await activationJobRepo.updateActivationJob(job.id, {
      currentStep: "mark_live",
      stepHistory: updateStepHistory(
        updateStepHistory(activeJob.stepHistory, "verify_runtime_health", "completed"),
        "mark_live",
        "running"
      ),
    });

    await restaurantRepo.upsertRestaurant(
      activeJob.restaurantId,
      buildRestaurantActivationPatch(context.restaurant, {
        state: "active",
        note: "Activation job completed successfully.",
        updatedAt: toIsoNow(),
        updatedBy: "system:activation-runner",
        manualOverrideUntil: "",
      })
    );

    if (restaurantHealthService) {
      await restaurantHealthService.evaluateAndPersistRestaurantHealth({
        restaurantId: activeJob.restaurantId,
        source: "activation_completed",
      });
    }

    return activationJobRepo.updateActivationJob(job.id, {
      status: "completed",
      currentStep: "completed",
      retryable: false,
      completedAt: toIsoNow(),
      error: "",
      blockers: [],
      stepHistory: updateStepHistory(
        updateStepHistory(activeJob.stepHistory, "mark_live", "completed"),
        "completed",
        "completed",
        { note: "Restaurant is now live." }
      ),
    });
  }

  function scheduleActivationJob({ jobId }) {
    setTimeout(async () => {
      try {
        await runActivationJob({ jobId });
      } catch (error) {
        logger.error("Activation job execution failed", {
          jobId,
          message: error.message,
          stack: error.stack,
        });
      }
    }, 0);
  }

  async function startActivationJob({
    restaurantId,
    requestId,
    note,
    requestedBy,
  }) {
    const safeRequestId = String(requestId || "").trim();
    const existing = safeRequestId
      ? await activationJobRepo.findActivationJobByRequestId({
          restaurantId,
          requestId: safeRequestId,
        })
      : null;
    if (existing) {
      return {
        job: existing,
        deduplicated: true,
      };
    }

    const context = await loadActivationContext({
      restaurantId,
      restaurantRepo,
      userRepo,
      menuRepo,
      providerSessionRepo,
      env,
    });
    if (!context) {
      return null;
    }

    const latestJob = await activationJobRepo.getLatestActivationJobByRestaurantId(restaurantId);
    if (latestJob && ["pending", "running", "retrying"].includes(normalizeJobStatus(latestJob.status))) {
      return {
        job: latestJob,
        deduplicated: true,
      };
    }

    await restaurantRepo.upsertRestaurant(
      restaurantId,
      buildRestaurantActivationPatch(context.restaurant, {
        state: "activating",
        note: String(note || "").trim() || "Activation job is in progress.",
        updatedAt: toIsoNow(),
        updatedBy: requestedBy,
      })
    );

    const created = await activationJobRepo.createActivationJob({
      restaurantId,
      requestId: safeRequestId,
      status: "pending",
      currentStep: "queued",
      requestedBy,
      note: String(note || "").trim(),
      type: "go_live_activation",
      retryable: false,
      steps: ACTIVATION_STEPS,
      stepHistory: [buildStepHistoryEntry("queued", "completed", { note: "Job queued." })],
    });

    scheduleActivationJob({ jobId: created.id });

    return {
      job: created,
      deduplicated: false,
    };
  }

  async function retryActivationJob({ jobId, requestedBy }) {
    const job = await activationJobRepo.getActivationJobById(jobId);
    if (!job) {
      return null;
    }

    if (normalizeJobStatus(job.status) !== "failed") {
      return job;
    }

    const context = await loadActivationContext({
      restaurantId: job.restaurantId,
      restaurantRepo,
      userRepo,
      menuRepo,
      providerSessionRepo,
      env,
    });
    if (!context) {
      return null;
    }

    await restaurantRepo.upsertRestaurant(
      job.restaurantId,
      buildRestaurantActivationPatch(context.restaurant, {
        state: "activating",
        note: "Activation retry is in progress.",
        updatedAt: toIsoNow(),
        updatedBy: requestedBy || "system:activation-retry",
      })
    );

    const updatedJob = await activationJobRepo.updateActivationJob(job.id, {
      status: "retrying",
      currentStep: "queued",
      retryable: false,
      error: "",
      blockers: [],
      requestedBy: requestedBy || job.requestedBy || "",
      stepHistory: updateStepHistory(job.stepHistory, "queued", "completed", {
        note: "Retry queued.",
      }),
    });

    scheduleActivationJob({ jobId: updatedJob.id });
    return updatedJob;
  }

  async function runActivationSweep({ source = "background_activation_sweep" } = {}) {
    const jobs = await activationJobRepo.listActivationJobsByStatuses({
      statuses: ["pending", "retrying"],
      limit: 20,
    });

    const results = [];
    for (const job of jobs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await runActivationJob({ jobId: job.id });
        if (result) {
          results.push(result);
        }
      } catch (error) {
        logger.error("Activation sweep job failed", {
          source,
          jobId: job.id,
          restaurantId: job.restaurantId,
          message: error.message,
          stack: error.stack,
        });
      }
    }

    return results;
  }

  function startBackgroundMonitor({ intervalMs }) {
    const safeIntervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 15000;
    if (monitorTimer) {
      return () => clearInterval(monitorTimer);
    }

    logger.info("Restaurant activation monitor started", {
      intervalMs: safeIntervalMs,
    });

    const run = async () => {
      if (monitorRunning) {
        return;
      }
      monitorRunning = true;
      try {
        await runActivationSweep({ source: "background_activation_sweep" });
      } catch (error) {
        logger.error("Restaurant activation sweep failed", {
          message: error.message,
          stack: error.stack,
        });
      } finally {
        monitorRunning = false;
      }
    };

    run();
    monitorTimer = setInterval(run, safeIntervalMs);
    return () => {
      clearInterval(monitorTimer);
      monitorTimer = null;
    };
  }

  return {
    startActivationJob,
    retryActivationJob,
    runActivationJob,
    runActivationSweep,
    startBackgroundMonitor,
  };
}

module.exports = {
  createRestaurantActivationService,
};
