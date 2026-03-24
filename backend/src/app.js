const express = require("express");
const cors = require("cors");

const { env } = require("./config/env");
const logger = require("./infra/logger");

const restaurantRepo = require("./repositories/restaurantRepo");
const apiKeyRepo = require("./repositories/apiKeyRepo");
const menuRepo = require("./repositories/menuRepo");
const deliveryZoneRepo = require("./repositories/deliveryZoneRepo");
const customerRepo = require("./repositories/customerRepo");
const orderRepo = require("./repositories/orderRepo");
const paymentReceiptRepo = require("./repositories/paymentReceiptRepo");
const providerSessionRepo = require("./repositories/providerSessionRepo");
const inboundEventRepo = require("./repositories/inboundEventRepo");
const outboxRepo = require("./repositories/outboxRepo");

const { createRequireApiKey } = require("./middleware/requireApiKey");
const { createRequireRestaurantAccess } = require("./middleware/requireRestaurantAccess");

const { createOrderParsingService } = require("./domain/services/orderParsingService");
const { createMenuService } = require("./domain/services/menuService");
const { createCustomerService } = require("./domain/services/customerService");
const { createOrderService } = require("./domain/services/orderService");
const { createPaymentService } = require("./domain/services/paymentService");
const { createInboundMessageService } = require("./domain/services/inboundMessageService");
const { createOutboxService } = require("./domain/services/outboxService");

const { ProviderRegistry } = require("./transport/providers/providerRegistry");
const { createChannelGateway } = require("./transport/providers/channelGateway");
const { createWhatsappAdapter } = require("./channels/whatsapp-web/whatsappAdapter");
const {
  createWhatsappRuntimeHttpAdapter,
} = require("./channels/whatsapp-runtime-http/whatsappRuntimeHttpAdapter");
const {
  createDormantWhatsappAdapter,
} = require("./channels/whatsapp-web/dormantWhatsappRuntime");
const {
  createChannelSessionService,
} = require("./transport/session/channelSessionService");

const { createHealthRoutes } = require("./routes/healthRoutes");
const { createRestaurantRoutes } = require("./routes/restaurantRoutes");
const { createMenuRoutes } = require("./routes/menuRoutes");
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

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  const requireApiKey = createRequireApiKey({ apiKeyRepo, logger });
  const requireRestaurantAccess = createRequireRestaurantAccess({ restaurantRepo });

  const orderParsingService = createOrderParsingService({
    openAIApiKey: env.OPENAI_API_KEY,
    logger,
  });

  const providerRegistry = new ProviderRegistry();
  const internalWhatsappRuntimeEnabled = env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME;
  const externalWhatsappRuntimeEnabled = env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME;
  let whatsappAdapter;

  if (internalWhatsappRuntimeEnabled) {
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
    logger,
    menuCooldownMs: env.INBOUND_MENU_COOLDOWN_SECONDS * 1000,
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

  app.use(createHealthRoutes());

  const restaurantApiBase = "/api/restaurants/:restaurantId";

  app.use(
    restaurantApiBase,
    createRestaurantRoutes({
      requireApiKey,
      requireRestaurantAccess,
      restaurantRepo,
    })
  );
  app.use(
    restaurantApiBase,
    createMenuRoutes({ requireApiKey, requireRestaurantAccess, menuRepo })
  );
  app.use(
    restaurantApiBase,
    createDeliveryZoneRoutes({
      requireApiKey,
      requireRestaurantAccess,
      deliveryZoneRepo,
    })
  );
  app.use(
    restaurantApiBase,
    createOrderRoutes({ requireApiKey, requireRestaurantAccess, orderService })
  );
  app.use(
    restaurantApiBase,
    createPaymentRoutes({
      requireApiKey,
      requireRestaurantAccess,
      paymentService,
    })
  );
  app.use(
    restaurantApiBase,
    createOutboxRoutes({
      requireApiKey,
      requireRestaurantAccess,
      outboxService,
    })
  );
  app.use(
    restaurantApiBase,
    createOpsRoutes({
      requireApiKey,
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
      requireApiKey,
      requireRestaurantAccess,
      channelSessionService,
    })
  );
  app.use(
    restaurantApiBase,
    createWhatsappSessionRoutes({
      requireApiKey,
      requireRestaurantAccess,
      channelSessionService,
    })
  );
  app.use(
    restaurantApiBase,
    createMessageRoutes({
      requireApiKey,
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

  return app;
}

module.exports = {
  createApp,
};
