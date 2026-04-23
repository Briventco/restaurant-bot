const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");
const { ROLES } = require("../auth/permissions");
const {
  resolveWhatsappChannelStatus,
  normalizeProvisioningState,
  getWhatsappProvisioningTransitions,
} = require("../utils/whatsappChannelStatus");
const {
  buildRestaurantActivationValidation,
  getAllowedLifecycleTransition,
  getLifecycleTransitionOptions,
} = require("../domain/services/restaurantActivationValidationService");

function inferRestaurantStatus(restaurant = {}) {
  return restaurant.status === "suspended" || restaurant.isActive === false
    ? "suspended"
    : "active";
}

function inferActivationState(restaurant = {}, whatsapp = null) {
  const explicitState = String(
    restaurant &&
      restaurant.activation &&
      typeof restaurant.activation === "object" &&
      restaurant.activation.state
      ? restaurant.activation.state
      : ""
  )
    .trim()
    .toLowerCase();

  if (explicitState) {
    return explicitState;
  }

  if (whatsapp && whatsapp.bindingMode === "session") {
    return "active";
  }

  if (
    whatsapp &&
    (whatsapp.bindingMode === "configured_pending_session" ||
      whatsapp.bindingMode === "global_meta_default")
  ) {
    return "configured";
  }

  return "draft";
}

function mapActivationJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    status: String(job.status || "pending").trim().toLowerCase() || "pending",
    currentStep: String(job.currentStep || "queued").trim().toLowerCase() || "queued",
    type: String(job.type || "go_live_activation").trim().toLowerCase() || "go_live_activation",
    requestId: String(job.requestId || "").trim(),
    note: String(job.note || "").trim(),
    requestedBy: String(job.requestedBy || "").trim(),
    blockers: Array.isArray(job.blockers) ? job.blockers : [],
    stepHistory: Array.isArray(job.stepHistory) ? job.stepHistory : [],
    error: String(job.error || "").trim(),
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
  };
}

function summarizeRevenueFromOrders(orders) {
  return (orders || []).reduce((sum, order) => sum + Number(order.total || 0), 0);
}

function formatCityFromAddress(address) {
  const parts = String(address || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length ? parts[parts.length - 1] : "";
}

function formatJoinedDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function mapOutboxStatusForAdmin(status) {
  const normalized = String(status || "").trim().toLowerCase();

  if (normalized === "sent") {
    return "delivered";
  }

  if (normalized === "queued" || normalized === "processing") {
    return "pending";
  }

  if (normalized === "retrying") {
    return "retrying";
  }

  if (normalized === "failed") {
    return "failed";
  }

  return normalized || "pending";
}

async function buildRestaurantSummary({
  restaurant,
  userRepo,
  menuRepo,
  orderRepo,
  providerSessionRepo,
  restaurantHealthRepo,
  activationJobRepo,
  env,
}) {
  const [users, recentOrders, menuItems, session, currentHealth, latestActivationJob] = await Promise.all([
    userRepo.listUsersByRestaurantId(restaurant.id),
    orderRepo.listOrders(restaurant.id, { limit: 200 }),
    menuRepo.listMenuItems(restaurant.id),
    providerSessionRepo.getSession(restaurant.id, "whatsapp-web"),
    restaurantHealthRepo.getCurrentHealth(restaurant.id),
    activationJobRepo ? activationJobRepo.getLatestActivationJobByRestaurantId(restaurant.id) : null,
  ]);

  const adminUser =
    users.find((user) => user.role === ROLES.RESTAURANT_ADMIN) || users[0] || null;
  const whatsapp = resolveWhatsappChannelStatus({
    restaurant,
    restaurantId: restaurant.id,
    session,
    env,
  });
  const activationValidation = buildRestaurantActivationValidation({
    restaurant,
    adminUser,
    menuItems,
    whatsapp,
  });
  const activationState = inferActivationState(restaurant, whatsapp);
  const activationTransitions = getLifecycleTransitionOptions({
    currentState: activationState,
    validation: activationValidation,
  });

  return {
    id: restaurant.id,
    restaurantId: restaurant.id,
    name: restaurant.name || "Restaurant",
    owner: (adminUser && adminUser.displayName) || restaurant.name || "Unassigned",
    ownerEmail: (adminUser && adminUser.email) || restaurant.email || "",
    email: restaurant.email || "",
    phone: restaurant.phone || "",
    address: restaurant.address || "",
    city: formatCityFromAddress(restaurant.address),
    timezone: restaurant.timezone || "Africa/Lagos",
    plan: restaurant.plan || "Starter",
    status: inferRestaurantStatus(restaurant),
    activationState,
    activationNote:
      restaurant && restaurant.activation && typeof restaurant.activation === "object"
        ? String(restaurant.activation.note || "")
        : "",
    activationChecklist: activationValidation.checklist,
    activationValidation,
    activationTransitions,
    latestActivationJob: mapActivationJob(latestActivationJob),
    healthStatus: currentHealth && currentHealth.status ? currentHealth.status : "unknown",
    healthIssues: currentHealth && Array.isArray(currentHealth.issues) ? currentHealth.issues : [],
    healthLastCheckedAt: currentHealth && currentHealth.checkedAt ? currentHealth.checkedAt : null,
    whatsappStatus: whatsapp.status,
    whatsappBindingMode: whatsapp.bindingMode,
    whatsappProvisioningState: whatsapp.provisioningState,
    whatsappActivationReady: Boolean(whatsapp.activationReady),
    whatsappRoutingMode: whatsapp.routingMode,
    whatsappRoutingHint: whatsapp.routingHint,
    orders: recentOrders.length,
    revenue: summarizeRevenueFromOrders(recentOrders),
    joined: formatJoinedDate(restaurant.createdAt),
    createdAt: restaurant.createdAt || null,
    updatedAt: restaurant.updatedAt || null,
  };
}

async function buildSessionSnapshot({
  restaurant,
  outboxService,
  providerSessionRepo,
  env,
}) {
  const session = await providerSessionRepo.getSession(restaurant.id, "whatsapp-web");
  const whatsapp = resolveWhatsappChannelStatus({
    restaurant,
    restaurantId: restaurant.id,
    session,
    env,
  });

  const outboxStats = await outboxService.getOutboxStats(restaurant.id);
  const sentCount = Number(outboxStats && outboxStats.counts ? outboxStats.counts.sent || 0 : 0);
  const failedCount = Number(
    outboxStats && outboxStats.counts ? outboxStats.counts.failed || 0 : 0
  );

  return {
    id: restaurant.id,
    restaurantId: restaurant.id,
    restaurant: restaurant.name || "Restaurant",
    phone: whatsapp.phone || restaurant.phone || "",
    status: whatsapp.status,
    provider: whatsapp.provider || "",
    configured: whatsapp.configured,
    activationReady: Boolean(whatsapp.activationReady),
    bindingMode: whatsapp.bindingMode,
    provisioningState: whatsapp.provisioningState,
    routingMode: whatsapp.routingMode,
    routingHint: whatsapp.routingHint,
    lastActive: whatsapp.lastActive,
    lastConnectedAt:
      (session && session.lastConnectedAt) || whatsapp.lastActive || null,
    lastDisconnectedAt: (session && session.lastDisconnectedAt) || null,
    qrAvailable: Boolean(session && session.qrAvailable),
    qrGeneratedAt: (session && session.qrGeneratedAt) || null,
    qrExpiresAt: (session && session.qrExpiresAt) || null,
    lastError: String((session && session.lastError) || "").trim(),
    messagesSent: sentCount,
    messagesDelivered: sentCount,
    messagesFailed: failedCount,
    setupMessage: whatsapp.setupMessage,
  };
}

async function buildOutboxSnapshot({
  restaurant,
  outboxService,
  providerSessionRepo,
  env,
  status,
  limit,
}) {
  const session = await providerSessionRepo.getSession(restaurant.id, "whatsapp-web");
  const whatsapp = resolveWhatsappChannelStatus({
    restaurant,
    restaurantId: restaurant.id,
    session,
    env,
  });

  const messages = await outboxService.listOutboxMessages({
    restaurantId: restaurant.id,
    status,
    limit,
  });

  return messages.map((message) => ({
    id: message.id,
    restaurantId: restaurant.id,
    restaurant: restaurant.name || "Restaurant",
    recipient: message.recipient || "",
    message: message.text || "",
    provider: whatsapp.provider || "",
    bindingMode: whatsapp.bindingMode,
    routingMode: whatsapp.routingMode,
    routingHint: whatsapp.routingHint,
    phoneNumberId: whatsapp.phoneNumberId || "",
    status: mapOutboxStatusForAdmin(message.status),
    rawStatus: message.status || "",
    time: message.updatedAt || message.createdAt || null,
    retries: Number(message.attemptCount || 0),
  }));
}

function createAdminRoutes({
  requireAuth,
  requireRole,
  admin,
  restaurantRepo,
  userRepo,
  menuRepo,
  orderRepo,
  deliveryZoneRepo,
  providerSessionRepo,
  whatsappSessionEventRepo,
  routingAuditRepo,
  restaurantHealthRepo,
  activationJobRepo,
  outboxService,
  channelSessionService,
  restaurantHealthService,
  restaurantActivationService,
  restaurantOnboardingService,
  env,
}) {
  const router = Router();
  const requireSuperAdmin = requireRole("super_admin");

  router.use(requireAuth, requireSuperAdmin);

  router.get("/dashboard", (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        message: "Super admin dashboard scaffold",
      },
    });
  });

  router.get("/restaurants", async (_req, res, next) => {
    try {
      const restaurants = await restaurantRepo.listRestaurants({ limit: 100 });
      const items = await Promise.all(
        restaurants.map((restaurant) =>
          buildRestaurantSummary({
            restaurant,
            userRepo,
            menuRepo,
            orderRepo,
            providerSessionRepo,
            restaurantHealthRepo,
            activationJobRepo,
            env,
          })
        )
      );

      res.status(200).json({
        success: true,
        items,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/restaurants/:restaurantId", async (req, res, next) => {
    try {
      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const [summary, users, orders, menuItems, deliveryZones, session, healthEvents] = await Promise.all([
          buildRestaurantSummary({
            restaurant,
            userRepo,
            menuRepo,
            orderRepo,
            providerSessionRepo,
            restaurantHealthRepo,
            activationJobRepo,
            env,
          }),
        userRepo.listUsersByRestaurantId(req.params.restaurantId),
        orderRepo.listOrders(req.params.restaurantId, { limit: 20 }),
        menuRepo.listMenuItems(req.params.restaurantId),
        deliveryZoneRepo.listDeliveryZones(req.params.restaurantId),
        providerSessionRepo.getSession(req.params.restaurantId, "whatsapp-web"),
        restaurantHealthRepo.listRecentHealthEvents({
          restaurantId: req.params.restaurantId,
          limit: 10,
        }),
      ]);

      const enrichedOrders = orders.map((order) => ({
        id: order.id,
        customer:
          order.customerName ||
          order.channelCustomerId ||
          order.customerPhone ||
          "Customer",
        amount: Number(order.total || 0),
        status: order.status || "pending_confirmation",
        items: Array.isArray(order.matched)
          ? order.matched.map((item) => item.name).join(", ")
          : "",
        createdAt: order.createdAt || null,
      }));

      const derivedPayments = enrichedOrders
        .filter((order) => order.amount > 0)
        .slice(0, 12)
        .map((order) => ({
          id: order.id,
          orderId: order.id,
          customer: order.customer,
          amount: order.amount,
          method: "Not configured",
          status:
            order.status === "cancelled" || order.status === "rejected"
              ? "failed"
              : "confirmed",
          date: order.createdAt || null,
        }));

      const adminUser =
        users.find((user) => user.role === ROLES.RESTAURANT_ADMIN) || users[0] || null;
      const whatsapp = resolveWhatsappChannelStatus({
        restaurant,
        restaurantId: req.params.restaurantId,
        session,
        env,
      });
      const activationValidation = buildRestaurantActivationValidation({
        restaurant,
        adminUser,
        menuItems,
        whatsapp,
      });

      res.status(200).json({
        success: true,
        restaurant: {
          ...summary,
          activationChecklist: activationValidation.checklist,
          activationValidation,
        },
        users,
        orders: enrichedOrders,
        menuItems,
        deliveryZones,
        healthEvents,
        payments: derivedPayments,
        whatsapp: {
          ...whatsapp,
          raw: session || null,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/restaurants/:restaurantId/lifecycle",
    validateBody({
      activationState: { type: "string", required: true, minLength: 3 },
      note: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
        if (!restaurant) {
          res.status(404).json({ error: "Restaurant not found" });
          return;
        }

        const nextState = String(req.body.activationState || "").trim().toLowerCase();
        const allowedStates = new Set([
          "draft",
          "configured",
          "ready_for_activation",
          "active",
        ]);

        if (!allowedStates.has(nextState)) {
          res.status(400).json({ error: "Invalid activation state" });
          return;
        }

        const [users, menuItems, session] = await Promise.all([
          userRepo.listUsersByRestaurantId(req.params.restaurantId),
          menuRepo.listMenuItems(req.params.restaurantId),
          providerSessionRepo.getSession(req.params.restaurantId, "whatsapp-web"),
        ]);
        const adminUser =
          users.find((user) => user.role === ROLES.RESTAURANT_ADMIN) || users[0] || null;
        const whatsapp = resolveWhatsappChannelStatus({
          restaurant,
          restaurantId: req.params.restaurantId,
          session,
          env,
        });
        const currentState = inferActivationState(restaurant, whatsapp);
        const activationValidation = buildRestaurantActivationValidation({
          restaurant,
          adminUser,
          menuItems,
          whatsapp,
        });
        const transition = getAllowedLifecycleTransition({
          currentState,
          nextState,
          validation: activationValidation,
        });

        if (!transition.allowed) {
          res.status(400).json({
            error: transition.message,
            code: transition.code,
            transition,
            validation: activationValidation,
            restaurant: {
              id: restaurant.id,
              activationState: currentState,
              activationChecklist: activationValidation.checklist,
              activationValidation,
            },
          });
          return;
        }

        const updatedRestaurant = await restaurantRepo.upsertRestaurant(req.params.restaurantId, {
          activation: {
            state: nextState,
            note: String(req.body.note || "").trim(),
            updatedBy: req.user.uid,
            updatedAt: new Date().toISOString(),
            manualOverrideUntil: new Date(
              Date.now() + Math.max(0, Number(env.RESTAURANT_HEALTH_MANUAL_OVERRIDE_MS) || 0)
            ).toISOString(),
          },
        });
        const [summary, refreshedUsers, refreshedMenuItems, refreshedSession] = await Promise.all([
          buildRestaurantSummary({
            restaurant: updatedRestaurant,
            userRepo,
            menuRepo,
            orderRepo,
            providerSessionRepo,
            restaurantHealthRepo,
            activationJobRepo,
            env,
          }),
          userRepo.listUsersByRestaurantId(req.params.restaurantId),
          menuRepo.listMenuItems(req.params.restaurantId),
          providerSessionRepo.getSession(req.params.restaurantId, "whatsapp-web"),
        ]);
        const refreshedAdminUser =
          refreshedUsers.find((user) => user.role === ROLES.RESTAURANT_ADMIN) ||
          refreshedUsers[0] ||
          null;
        const refreshedWhatsapp = resolveWhatsappChannelStatus({
          restaurant: updatedRestaurant,
          restaurantId: req.params.restaurantId,
          session: refreshedSession,
          env,
        });
        const postUpdateValidation = buildRestaurantActivationValidation({
          restaurant: updatedRestaurant,
          adminUser: refreshedAdminUser,
          menuItems: refreshedMenuItems,
          whatsapp: refreshedWhatsapp,
        });

        res.status(200).json({
          success: true,
          restaurant: {
            ...summary,
            activationChecklist: postUpdateValidation.checklist,
            activationValidation: postUpdateValidation,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/restaurants/:restaurantId/transition",
    validateBody({
      targetState: { type: "string", required: true, minLength: 3 },
      requestId: { type: "string", required: false },
      note: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
        if (!restaurant) {
          res.status(404).json({ error: "Restaurant not found" });
          return;
        }

        const targetState = String(req.body.targetState || "").trim().toLowerCase();
        if (targetState === "activating") {
          res.status(400).json({
            error: "Activating is an internal orchestration state and cannot be requested manually.",
            code: "manual_activating_not_allowed",
          });
          return;
        }
        const [users, menuItems, session] = await Promise.all([
          userRepo.listUsersByRestaurantId(req.params.restaurantId),
          menuRepo.listMenuItems(req.params.restaurantId),
          providerSessionRepo.getSession(req.params.restaurantId, "whatsapp-web"),
        ]);
        const adminUser =
          users.find((user) => user.role === ROLES.RESTAURANT_ADMIN) || users[0] || null;
        const whatsapp = resolveWhatsappChannelStatus({
          restaurant,
          restaurantId: req.params.restaurantId,
          session,
          env,
        });
        const currentState = inferActivationState(restaurant, whatsapp);
        const activationValidation = buildRestaurantActivationValidation({
          restaurant,
          adminUser,
          menuItems,
          whatsapp,
        });
        const transition = getAllowedLifecycleTransition({
          currentState,
          nextState: targetState,
          validation: activationValidation,
        });

        if (currentState === targetState) {
          const currentSummary = await buildRestaurantSummary({
            restaurant,
            userRepo,
            menuRepo,
            orderRepo,
            providerSessionRepo,
            restaurantHealthRepo,
            activationJobRepo,
            env,
          });

          res.status(200).json({
            success: true,
            restaurant: currentSummary,
            transition: {
              from: currentState,
              to: targetState,
              allowed: true,
              code: "transition_noop",
            },
          });
          return;
        }

        if (!transition.allowed) {
          res.status(400).json({
            error: transition.message,
            code: transition.code,
            transition,
            restaurant: {
              id: restaurant.id,
              activationState: currentState,
              activationChecklist: activationValidation.checklist,
              activationValidation,
              activationTransitions: getLifecycleTransitionOptions({
                currentState,
                validation: activationValidation,
              }),
            },
          });
          return;
        }

        let refreshed;
        let transitionResponse = {
          from: currentState,
          to: targetState,
          allowed: true,
          code: "transition_applied",
        };

        if (targetState === "active") {
          if (!restaurantActivationService) {
            res.status(500).json({
              error: "Activation service is not configured.",
            });
            return;
          }

          const activationResult = await restaurantActivationService.startActivationJob({
            restaurantId: req.params.restaurantId,
            requestId: String(req.body.requestId || "").trim(),
            note:
              String(req.body.note || "").trim() ||
              "Activation requested through Activation Center.",
            requestedBy: req.user.uid,
          });

          if (!activationResult) {
            res.status(404).json({ error: "Restaurant not found" });
            return;
          }

          const latestRestaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
          refreshed = await buildRestaurantSummary({
            restaurant: latestRestaurant,
            userRepo,
            menuRepo,
            orderRepo,
            providerSessionRepo,
            restaurantHealthRepo,
            activationJobRepo,
            env,
          });
          transitionResponse = {
            from: currentState,
            to: refreshed.activationState || "activating",
            allowed: true,
            code: activationResult.deduplicated
              ? "activation_job_reused"
              : "activation_job_started",
            activationJob: mapActivationJob(activationResult.job),
          };
        } else {
          const updatedRestaurant = await restaurantRepo.upsertRestaurant(req.params.restaurantId, {
            activation: {
              ...(restaurant.activation && typeof restaurant.activation === "object"
                ? restaurant.activation
                : {}),
              state: targetState,
              note:
                String(req.body.note || "").trim() ||
                `Transitioned to ${targetState} through Activation Center.`,
              updatedBy: req.user.uid,
              updatedAt: new Date().toISOString(),
              manualOverrideUntil: new Date(
                Date.now() + Math.max(0, Number(env.RESTAURANT_HEALTH_MANUAL_OVERRIDE_MS) || 0)
              ).toISOString(),
            },
          });

          if (restaurantHealthService) {
            await restaurantHealthService.evaluateAndPersistRestaurantHealth({
              restaurantId: req.params.restaurantId,
              source: "admin_transition",
            });
          }

          refreshed = await buildRestaurantSummary({
            restaurant: updatedRestaurant,
            userRepo,
            menuRepo,
            orderRepo,
            providerSessionRepo,
            restaurantHealthRepo,
            activationJobRepo,
            env,
          });
        }

        res.status(200).json({
          success: true,
          restaurant: refreshed,
          transition: transitionResponse,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.patch(
    "/restaurants/:restaurantId/whatsapp-config",
    validateBody({
      provider: { type: "string", required: false },
      configured: { type: "boolean", required: false },
      provisioningState: { type: "string", required: false },
      phone: { type: "string", required: false },
      phoneNumberId: { type: "string", required: false },
      wabaId: { type: "string", required: false },
      notes: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
        if (!restaurant) {
          res.status(404).json({ error: "Restaurant not found" });
          return;
        }

        const currentWhatsapp =
          restaurant.whatsapp && typeof restaurant.whatsapp === "object"
            ? restaurant.whatsapp
            : {};

        const patch = {
          ...currentWhatsapp,
        };

        if (typeof req.body.provider === "string") {
          patch.provider = req.body.provider.trim().toLowerCase();
        }

        if (typeof req.body.configured === "boolean") {
          patch.configured = req.body.configured;
        }

        if (typeof req.body.provisioningState === "string") {
          patch.provisioningState = normalizeProvisioningState(req.body.provisioningState);
        }

        if (typeof req.body.phone === "string") {
          patch.phone = req.body.phone.trim();
        }

        if (typeof req.body.phoneNumberId === "string") {
          patch.phoneNumberId = req.body.phoneNumberId.trim();
        }

        if (typeof req.body.wabaId === "string") {
          patch.wabaId = req.body.wabaId.trim();
        }

        if (typeof req.body.notes === "string") {
          patch.notes = req.body.notes.trim();
        }

        if (patch.configured === false) {
          patch.provider = "";
          patch.provisioningState = "unassigned";
          patch.phone = "";
          patch.phoneNumberId = "";
          patch.wabaId = "";
          patch.notes = "";
        }

        const currentProvisioningState = normalizeProvisioningState(
          currentWhatsapp.provisioningState,
          currentWhatsapp.configured ? "reserved" : "unassigned"
        );
        const nextProvisioningState = normalizeProvisioningState(
          patch.provisioningState,
          patch.configured ? "reserved" : "unassigned"
        );
        const allowedProvisioningTargets = new Set(
          getWhatsappProvisioningTransitions(currentProvisioningState).map((item) => item.targetState)
        );

        if (
          patch.configured !== false &&
          nextProvisioningState !== currentProvisioningState &&
          !allowedProvisioningTargets.has(nextProvisioningState)
        ) {
          res.status(400).json({
            error: `Cannot move WhatsApp provisioning from ${currentProvisioningState} to ${nextProvisioningState}.`,
            code: "invalid_whatsapp_provisioning_transition",
            provisioningTransitions: getWhatsappProvisioningTransitions(currentProvisioningState),
          });
          return;
        }

        if (patch.configured !== false && ["verified", "active"].includes(nextProvisioningState)) {
          if (!String(patch.phone || "").trim()) {
            res.status(400).json({
              error: "Display phone is required before WhatsApp provisioning can be verified.",
              code: "whatsapp_phone_required",
            });
            return;
          }

          if (
            String(patch.provider || "").trim().toLowerCase() === "meta-whatsapp-cloud-api" &&
            (!String(patch.phoneNumberId || "").trim() || !String(patch.wabaId || "").trim())
          ) {
            res.status(400).json({
              error: "Meta phone number ID and WABA ID are required before WhatsApp provisioning can be verified.",
              code: "whatsapp_meta_identifiers_required",
            });
            return;
          }
        }

        patch.provisioningState = patch.configured === false ? "unassigned" : nextProvisioningState;

        const updatedRestaurant = await restaurantRepo.upsertRestaurant(req.params.restaurantId, {
          whatsapp: patch,
        });
        const session = await providerSessionRepo.getSession(
          req.params.restaurantId,
          "whatsapp-web"
        );

        res.status(200).json({
          success: true,
          whatsapp: resolveWhatsappChannelStatus({
            restaurant: updatedRestaurant,
            restaurantId: req.params.restaurantId,
            session,
            env,
          }),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get("/sessions", async (_req, res, next) => {
    try {
      const restaurants = await restaurantRepo.listRestaurants({ limit: 100 });
      const items = await Promise.all(
        restaurants.map((restaurant) =>
          buildSessionSnapshot({
            restaurant,
            outboxService,
            providerSessionRepo,
            env,
          })
        )
      );

      res.status(200).json({
        success: true,
        items,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:restaurantId/restart", async (req, res, next) => {
    try {
      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const session = await providerSessionRepo.getSession(req.params.restaurantId, "whatsapp-web");
      const whatsapp = resolveWhatsappChannelStatus({
        restaurant,
        restaurantId: req.params.restaurantId,
        session,
        env,
      });

      if (!whatsapp.configured) {
        res.status(400).json({
          error: "This restaurant does not have a WhatsApp line configured yet.",
        });
        return;
      }

      const liveSession = await channelSessionService.restart({
        channel: "whatsapp-web",
        restaurantId: req.params.restaurantId,
        reason: "super_admin_restart",
      });

      res.status(200).json({
        success: true,
        session: liveSession,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:restaurantId/start", async (req, res, next) => {
    try {
      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const liveSession = await channelSessionService.start({
        channel: "whatsapp-web",
        restaurantId: req.params.restaurantId,
      });

      res.status(200).json({
        success: true,
        session: liveSession,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/sessions/:restaurantId/qr", async (req, res, next) => {
    try {
      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const qr = await channelSessionService.getQr({
        channel: "whatsapp-web",
        restaurantId: req.params.restaurantId,
        includeImage: false,
      });

      if (!qr) {
        res.status(404).json({ error: "No active QR is available" });
        return;
      }

      res.status(200).json({
        success: true,
        qr,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/sessions/:restaurantId/events", async (req, res, next) => {
    try {
      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 20;
      const items = await whatsappSessionEventRepo.listRecentSessionEvents({
        restaurantId: req.params.restaurantId,
        limit,
      });

      res.status(200).json({
        success: true,
        items,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:restaurantId/disconnect", async (req, res, next) => {
    try {
      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const session = await providerSessionRepo.getSession(req.params.restaurantId, "whatsapp-web");
      const whatsapp = resolveWhatsappChannelStatus({
        restaurant,
        restaurantId: req.params.restaurantId,
        session,
        env,
      });

      if (!whatsapp.configured) {
        res.status(400).json({
          error: "This restaurant does not have a WhatsApp line configured yet.",
        });
        return;
      }

      const liveSession = await channelSessionService.disconnect({
        channel: "whatsapp-web",
        restaurantId: req.params.restaurantId,
        reason: "super_admin_disconnect",
      });

      res.status(200).json({
        success: true,
        session: liveSession,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/outbox", async (req, res, next) => {
    try {
      const restaurants = await restaurantRepo.listRestaurants({ limit: 100 });
      const perRestaurantLimit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 25;
      const status = String(req.query.status || "").trim();

      const perRestaurantMessages = await Promise.all(
        restaurants.map((restaurant) =>
          buildOutboxSnapshot({
            restaurant,
            outboxService,
            providerSessionRepo,
            env,
            status,
            limit: perRestaurantLimit,
          })
        )
      );

      const items = perRestaurantMessages
        .flat()
        .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime())
        .slice(0, 200);

      res.status(200).json({
        success: true,
        items,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/routing-audits", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 50;
      const restaurantId = String(req.query.restaurantId || "").trim();

      const items = await routingAuditRepo.listRecentRoutingAudits({
        limit,
        restaurantId,
      });

      res.status(200).json({
        success: true,
        items,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/health-monitor", async (req, res, next) => {
    try {
      const restaurants = await restaurantRepo.listRestaurants({ limit: 100 });
      const items = await Promise.all(
        restaurants.map((restaurant) =>
          buildRestaurantSummary({
            restaurant,
            userRepo,
            menuRepo,
            orderRepo,
            providerSessionRepo,
            restaurantHealthRepo,
            activationJobRepo,
            env,
          })
        )
      );
      const recentEvents = await restaurantHealthRepo.listRecentHealthEvents({ limit: 100 });

      res.status(200).json({
        success: true,
        items,
        events: recentEvents,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/restaurants/:restaurantId/health/recheck", async (req, res, next) => {
    try {
      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const health = await restaurantHealthService.evaluateAndPersistRestaurantHealth({
        restaurantId: req.params.restaurantId,
        source: "admin_manual_recheck",
      });

      res.status(200).json({
        success: true,
        health,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/restaurants/:restaurantId/activation-jobs/:jobId/retry", async (req, res, next) => {
    try {
      if (!restaurantActivationService) {
        res.status(500).json({ error: "Activation service is not configured." });
        return;
      }

      const restaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      if (!restaurant) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
      }

      const job = await activationJobRepo.getActivationJobById(req.params.jobId);
      if (!job || job.restaurantId !== req.params.restaurantId) {
        res.status(404).json({ error: "Activation job not found" });
        return;
      }

      const retriedJob = await restaurantActivationService.retryActivationJob({
        jobId: req.params.jobId,
        requestedBy: req.user.uid,
      });

      const latestRestaurant = await restaurantRepo.getRestaurantById(req.params.restaurantId);
      const refreshed = await buildRestaurantSummary({
        restaurant: latestRestaurant,
        userRepo,
        menuRepo,
        orderRepo,
        providerSessionRepo,
        restaurantHealthRepo,
        activationJobRepo,
        env,
      });

      res.status(200).json({
        success: true,
        restaurant: refreshed,
        activationJob: mapActivationJob(retriedJob),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/outbox/messages/:messageId/retry", async (req, res, next) => {
    try {
      const existing = await outboxService.getOutboxMessageById(req.params.messageId);
      if (!existing) {
        res.status(404).json({ error: "Outbox message not found" });
        return;
      }

      const message = await outboxService.retryOutboxMessage({
        restaurantId: existing.restaurantId,
        messageId: req.params.messageId,
        requestedBy: req.user.uid,
      });

      if (!message) {
        res.status(404).json({ error: "Outbox message not found" });
        return;
      }

      res.status(200).json({
        success: true,
        message: {
          id: message.id,
          restaurantId: message.restaurantId,
          recipient: message.recipient || "",
          message: message.text || "",
          provider: message.provider || "",
          bindingMode: message.bindingMode || "",
          routingMode: message.routingMode || "",
          routingHint: message.routingHint || "",
          phoneNumberId: message.phoneNumberId || "",
          status: mapOutboxStatusForAdmin(message.status),
          rawStatus: message.status || "",
          time: message.updatedAt || message.createdAt || null,
          retries: Number(message.attemptCount || 0),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/restaurants",
    validateBody({
      restaurantName: { type: "string", required: true, minLength: 2 },
      adminEmail: { type: "string", required: true, minLength: 5 },
      adminPassword: { type: "string", required: true, minLength: 6 },
      adminDisplayName: { type: "string", required: false },
      restaurantId: { type: "string", required: false },
      phone: { type: "string", required: false },
      address: { type: "string", required: false },
      timezone: { type: "string", required: false },
      openingHours: { type: "string", required: false },
      closingHours: { type: "string", required: false },
      seedSampleMenu: { type: "boolean", required: false },
    }),
    async (req, res, next) => {
      try {
        const created = await restaurantOnboardingService.createRestaurantWorkspace({
          restaurantName: req.body.restaurantName,
          adminEmail: req.body.adminEmail,
          adminPassword: req.body.adminPassword,
          adminDisplayName: req.body.adminDisplayName,
          restaurantId: req.body.restaurantId,
          phone: req.body.phone,
          address: req.body.address,
          timezone: req.body.timezone,
          openingHours: req.body.openingHours,
          closingHours: req.body.closingHours,
          seedSampleMenu: req.body.seedSampleMenu === true,
          createdBy: req.user.uid,
          source: "super_admin_onboarding",
        });

        res.status(201).json({
          success: true,
          ...created,
        });
      } catch (error) {
        if (error && error.statusCode === 409) {
          res.status(409).json({
            error: error.message,
          });
          return;
        }
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createAdminRoutes,
};
