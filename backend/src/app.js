const express = require("express");
const cors = require("cors");

const { env } = require("./config/env");
const logger = require("./infra/logger");
const { admin } = require("./infra/firebase");

const restaurantRepo = require("./repositories/restaurantRepo");
const userRepo = require("./repositories/userRepo");
const apiKeyRepo = require("./repositories/apiKeyRepo");
const menuRepo = require("./repositories/menuRepo");
const deliveryZoneRepo = require("./repositories/deliveryZoneRepo");
const customerRepo = require("./repositories/customerRepo");
const orderRepo = require("./repositories/orderRepo");
const paymentReceiptRepo = require("./repositories/paymentReceiptRepo");
const providerSessionRepo = require("./repositories/providerSessionRepo");
const inboundEventRepo = require("./repositories/inboundEventRepo");
const routingAuditRepo = require("./repositories/routingAuditRepo");
const restaurantHealthRepo = require("./repositories/restaurantHealthRepo");
const activationJobRepo = require("./repositories/activationJobRepo");
const outboxRepo = require("./repositories/outboxRepo");
const conversationSessionRepo = require("./repositories/conversationSessionRepo");

const { createRequireApiKey } = require("./middleware/requireApiKey");
const { createRequireRestaurantAccess } = require("./middleware/requireRestaurantAccess");
const { createRequireAuth } = require("./middleware/requireAuth");
const { requireRole } = require("./middleware/requireRole");
const { requirePermission } = require("./middleware/requirePermission");
const { requireRestaurantScope } = require("./middleware/requireRestaurantScope");
const {
  createRequirePortalOrApiKey,
} = require("./middleware/requirePortalOrApiKey");

const { createOrderParsingService } = require("./domain/services/orderParsingService");
const { createMenuService } = require("./domain/services/menuService");
const { createCustomerService } = require("./domain/services/customerService");
const { createOrderService } = require("./domain/services/orderService");
const { createPaymentService } = require("./domain/services/paymentService");
const { createInboundMessageService } = require("./domain/services/inboundMessageService");
const { createOutboxService } = require("./domain/services/outboxService");
const { createLlmService } = require("./domain/services/llmService");
const {
  createRestaurantHealthService,
} = require("./domain/services/restaurantHealthService");
const {
  createRestaurantActivationService,
} = require("./domain/services/restaurantActivationService");
const {
  createHealthAlertService,
} = require("./domain/services/healthAlertService");
const { createAuthService } = require("./auth/authService");

const { ProviderRegistry } = require("./transport/providers/providerRegistry");
const { createChannelGateway } = require("./transport/providers/channelGateway");
const { createWhatsappAdapter } = require("./channels/whatsapp-web/whatsappAdapter");
const { createWhatsappMetaAdapter } = require("./channels/whatsapp-meta/whatsappMetaAdapter");
const {
  createWhatsappRuntimeHttpAdapter,
} = require("./channels/whatsapp-runtime-http/whatsappRuntimeHttpAdapter");
const {
  createDormantWhatsappAdapter,
} = require("./channels/whatsapp-web/dormantWhatsappRuntime");
const {
  createChannelSessionService,
} = require("./transport/session/channelSessionService");

const {
  createHealthRoutes,
  buildHealthPayload,
  buildStatusPayload,
} = require("./routes/healthRoutes");
const { createAuthRoutes } = require("./routes/authRoutes");
const { createAdminRoutes } = require("./routes/adminRoutes");
const { createRestaurantRoutes } = require("./routes/restaurantRoutes");
const { createMenuRoutes } = require("./routes/menuRoutes");
const { createSettingsRoutes } = require("./routes/settingsRoutes");
const { createDeliveryZoneRoutes } = require("./routes/deliveryZoneRoutes");
const { createOrderRoutes } = require("./routes/orderRoutes");
const { createPaymentRoutes } = require("./routes/paymentRoutes");
const { createOutboxRoutes } = require("./routes/outboxRoutes");
const { createOpsRoutes } = require("./routes/opsRoutes");
const { createChannelSessionRoutes } = require("./routes/channelSessionRoutes");
const {
  createWhatsappSessionRoutes,
} = require("./routes/whatsappSessionRoutes");
const { createLegacyCompatRoutes } = require("./routes/legacyCompatRoutes");
const { createMessageRoutes } = require("./routes/messageRoutes");
const { createMetaWebhookRoutes } = require("./routes/metaWebhookRoutes");

const API_VERSION = "v1";
const API_BASE = `/api/${API_VERSION}`;

function createApp() {
  const app = express();
  const allowedOrigins = new Set(
    Array.isArray(env.CORS_ALLOWED_ORIGINS) ? env.CORS_ALLOWED_ORIGINS : []
  );
  const corsOptions = {
    origin(origin, callback) {
      if (!origin || allowedOrigins.size === 0 || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
    credentials: true,
  };

  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));
  app.use(express.json({ limit: "1mb" }));

  const requireApiKey = createRequireApiKey({ apiKeyRepo, logger });
  const requireRestaurantAccess = createRequireRestaurantAccess({ restaurantRepo });
  const authService = createAuthService({ admin, userRepo, logger });
  const requireAuth = createRequireAuth({ authService, logger });
  const requireApiKeyOrPortalAuth = createRequirePortalOrApiKey({
    requireApiKey,
    requireAuth,
    requirePermission,
    requireRestaurantScope,
  });

  const orderParsingService = createOrderParsingService({
    llmProvider: env.LLM_PROVIDER,
    openAIApiKey: env.OPENAI_API_KEY,
    openAIModel: env.OPENAI_MODEL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    logger,
  });
  const llmService = createLlmService({
    llmProvider: env.LLM_PROVIDER,
    openAIApiKey: env.OPENAI_API_KEY,
    openAIModel: env.OPENAI_MODEL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    logger,
  });

  const providerRegistry = new ProviderRegistry();
  const whatsappProvider = String(env.WHATSAPP_PROVIDER || "runtime-http").trim().toLowerCase();
  const internalWhatsappRuntimeEnabled = env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME;
  const externalWhatsappRuntimeEnabled = env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME;
  let whatsappAdapter;

  async function resolveRestaurantMetaConfig({ restaurantId }) {
    const safeRestaurantId = String(restaurantId || "").trim();
    const restaurant = safeRestaurantId
      ? await restaurantRepo.getRestaurantById(safeRestaurantId)
      : null;
    const whatsapp =
      restaurant && restaurant.whatsapp && typeof restaurant.whatsapp === "object"
        ? restaurant.whatsapp
        : {};

    const defaultRestaurantId = String(
      env.META_WEBHOOK_DEFAULT_RESTAURANT_ID || env.BACKEND_DEFAULT_RESTAURANT_ID || ""
    ).trim();
    const isDefaultMetaRestaurant =
      Boolean(env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID) &&
      Boolean(defaultRestaurantId) &&
      safeRestaurantId === defaultRestaurantId;

    const explicitProvider = String(whatsapp.provider || "").trim().toLowerCase();
    const explicitPhoneNumberId = String(whatsapp.phoneNumberId || "").trim();
    const explicitWabaId = String(whatsapp.wabaId || "").trim();
    const explicitPhone = String(whatsapp.phone || "").trim();
    const explicitlyConfigured =
      whatsapp.configured === true ||
      Boolean(explicitProvider) ||
      Boolean(explicitPhoneNumberId);

    if (explicitlyConfigured) {
      return {
        configured: true,
        provider: explicitProvider || "meta-whatsapp-cloud-api",
        accessToken: env.META_ACCESS_TOKEN,
        phoneNumberId: explicitPhoneNumberId,
        wabaId: explicitWabaId,
        phone: explicitPhone,
        setupMessage: "",
      };
    }

    if (isDefaultMetaRestaurant) {
      return {
        configured: true,
        provider: "meta-whatsapp-cloud-api",
        accessToken: env.META_ACCESS_TOKEN,
        phoneNumberId: env.META_PHONE_NUMBER_ID,
        wabaId: env.META_WABA_ID,
        phone: explicitPhone,
        setupMessage:
          "This restaurant is currently using the default shared Meta test line configured on the backend.",
      };
    }

    return {
      configured: false,
      provider: "",
      accessToken: "",
      phoneNumberId: "",
      wabaId: "",
      phone: "",
      setupMessage: "No WhatsApp line has been assigned to this restaurant yet.",
    };
  }

  if (whatsappProvider === "meta") {
    whatsappAdapter = createWhatsappMetaAdapter({
      accessToken: env.META_ACCESS_TOKEN,
      phoneNumberId: env.META_PHONE_NUMBER_ID,
      wabaId: env.META_WABA_ID,
      apiVersion: env.META_API_VERSION,
      logger,
      channel: "whatsapp-web",
      resolveConfigForRestaurant: resolveRestaurantMetaConfig,
    });

    logger.info("Backend WhatsApp provider is Meta Cloud API", {
      mode: "meta_cloud_api",
      phoneNumberId: env.META_PHONE_NUMBER_ID,
      wabaId: env.META_WABA_ID,
    });
  } else if (internalWhatsappRuntimeEnabled) {
    whatsappAdapter = createWhatsappAdapter({
      sessionRepo: providerSessionRepo,
      logger,
      qrTtlSeconds: env.WHATSAPP_QR_TTL_SECONDS,
    });

    logger.warn("Backend internal WhatsApp runtime is ENABLED", {
      mode: "dual_runtime",
      recommendation:
        "Disable BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME to keep whatsapp-bot as the only runtime.",
    });
  } else if (externalWhatsappRuntimeEnabled) {
    whatsappAdapter = createWhatsappRuntimeHttpAdapter({
      runtimeBaseUrl: env.WHATSAPP_RUNTIME_BASE_URL,
      runtimeApiKey: env.WHATSAPP_RUNTIME_API_KEY,
      requestTimeoutMs: env.WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS,
      logger,
    });

    logger.info("Backend WhatsApp runtime is external", {
      mode: "transport_via_external_whatsapp_runtime",
      runtimeBaseUrl: env.WHATSAPP_RUNTIME_BASE_URL || "",
    });
  } else {
    whatsappAdapter = createDormantWhatsappAdapter({ logger });

    logger.info("Backend internal WhatsApp runtime is disabled", {
      mode: "transport_runtime_disabled",
    });
  }

  providerRegistry.registerAdapter("whatsapp-web", whatsappAdapter);

  const channelGateway = createChannelGateway({
    providerRegistry,
    sessionRepo: providerSessionRepo,
    logger,
  });
  const channelSessionService = createChannelSessionService({
    channelGateway,
  });
  const outboxService = createOutboxService({
    outboxRepo,
    channelGateway,
    logger,
    inlineSendEnabled: env.OUTBOX_INLINE_SEND_ENABLED,
    defaultMaxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    retryBaseMs: env.OUTBOX_RETRY_BASE_MS,
    retryMaxMs: env.OUTBOX_RETRY_MAX_MS,
    leaseMs: env.OUTBOX_LEASE_MS,
  });

  const menuService = createMenuService({ menuRepo });
  const customerService = createCustomerService({ customerRepo });

  const orderService = createOrderService({
    menuRepo,
    orderRepo,
    restaurantRepo,
    orderParsingService,
    outboxService,
    conversationSessionRepo,
  });

  const paymentService = createPaymentService({
    paymentReceiptRepo,
    orderRepo,
    orderService,
  });

  const inboundMessageService = createInboundMessageService({
    inboundEventRepo,
    menuService,
    customerService,
    orderService,
    channelGateway,
    conversationSessionRepo,
    restaurantRepo,
    paymentService,
    llmService,
    logger,
    menuCooldownMs: env.INBOUND_MENU_COOLDOWN_SECONDS * 1000,
  });
  const healthAlertService = createHealthAlertService({
    env,
    logger,
  });
  const restaurantHealthService = createRestaurantHealthService({
    restaurantRepo,
    userRepo,
    menuRepo,
    providerSessionRepo,
    restaurantHealthRepo,
    healthAlertService,
    env,
    logger,
  });
  const restaurantActivationService = createRestaurantActivationService({
    restaurantRepo,
    userRepo,
    menuRepo,
    providerSessionRepo,
    activationJobRepo,
    restaurantHealthService,
    env,
    logger,
  });

  if (internalWhatsappRuntimeEnabled) {
    whatsappAdapter.setInboundHandler(async (payload) => {
      try {
        await inboundMessageService.handleInboundEvent(payload);
      } catch (error) {
        logger.error("Inbound message processing failed", {
          message: error.message,
          stack: error.stack,
        });
      }
    });
  }

  app.get("/", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "restaurant-bot-api",
      version: API_VERSION,
    });
  });

  // Temporary deployment probe route.
  app.get("/test", (_req, res) => {
    res.status(200).send("working");
  });

  // Health/status are registered as direct routes for deterministic production behavior.
  app.get(`${API_BASE}/health`, (_req, res) => {
    res.status(200).json(buildHealthPayload());
  });
  app.get(`${API_BASE}/status`, (_req, res) => {
    res.status(200).json(buildStatusPayload());
  });
  app.get("/health", (_req, res) => {
    res.status(200).json(buildHealthPayload());
  });
  app.get("/status", (_req, res) => {
    res.status(200).json(buildStatusPayload());
  });

  // Keep router-based health routes mounted as a compatibility fallback.
  app.use(API_BASE, createHealthRoutes());
  app.use(API_BASE, createAuthRoutes({ requireAuth, authService }));
  app.use(
    `${API_BASE}/admin`,
    createAdminRoutes({
      requireAuth,
      requireRole,
      admin,
      restaurantRepo,
      userRepo,
      menuRepo,
      orderRepo,
      deliveryZoneRepo,
      providerSessionRepo,
      routingAuditRepo,
      restaurantHealthRepo,
      activationJobRepo,
      outboxService,
      channelSessionService,
      restaurantHealthService,
      restaurantActivationService,
      env,
    })
  );
  // Unversioned aliases for deployment probes and simple uptime checks.
  app.use(createHealthRoutes());
  app.use(
    createMetaWebhookRoutes({
      env,
      logger,
      restaurantRepo,
      routingAuditRepo,
      inboundMessageService,
      channelGateway,
    })
  );

  const restaurantApiBase = `${API_BASE}/restaurants/:restaurantId`;

  app.use(
    restaurantApiBase,
    createRestaurantRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      restaurantRepo,
      providerSessionRepo,
      restaurantHealthService,
      env,
    })
  );
  app.use(
    restaurantApiBase,
    createMenuRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      menuRepo,
      restaurantHealthService,
    })
  );
  app.use(
    restaurantApiBase,
    createSettingsRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      restaurantRepo,
      restaurantHealthService,
    })
  );
  app.use(
    restaurantApiBase,
    createDeliveryZoneRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      deliveryZoneRepo,
    })
  );
  app.use(
    restaurantApiBase,
    createOrderRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      orderService,
    })
  );
  app.use(
    restaurantApiBase,
    createPaymentRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      paymentService,
    })
  );
  app.use(
    restaurantApiBase,
    createOutboxRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      outboxService,
    })
  );
  app.use(
    restaurantApiBase,
    createOpsRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      orderService,
      outboxService,
      channelSessionService,
      inboundEventRepo,
    })
  );
  app.use(
    restaurantApiBase,
    createChannelSessionRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      channelSessionService,
    })
  );
  app.use(
    restaurantApiBase,
    createWhatsappSessionRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      channelSessionService,
    })
  );
  app.use(
    restaurantApiBase,
    createMessageRoutes({
      requireApiKey: requireApiKeyOrPortalAuth,
      requireRestaurantAccess,
      inboundMessageService,
      logger,
    })
  );

  app.use(
    createLegacyCompatRoutes({
      env,
      logger,
      requireApiKey,
      requireRestaurantAccess,
      orderService,
    })
  );

  app.use((req, res) => {
    res.status(404).json({
      error: "Route not found",
      path: req.originalUrl,
    });
  });

  app.use((error, _req, res, _next) => {
    const statusCode = error.statusCode || 500;

    if (statusCode >= 500) {
      logger.error("Unhandled backend error", {
        message: error.message,
        stack: error.stack,
      });
    }

    res.status(statusCode).json({
      error: error.message || "Internal server error",
      ...(error.details ? { details: error.details } : {}),
    });
  });

  app.locals.restaurantHealthService = restaurantHealthService;
  app.locals.restaurantActivationService = restaurantActivationService;

  return app;
}

module.exports = {
  createApp,
  API_BASE,
  API_VERSION,
};
