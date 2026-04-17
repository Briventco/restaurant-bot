const os = require("os");

const { env } = require("../config/env");
const logger = require("../infra/logger");
const providerSessionRepo = require("../repositories/providerSessionRepo");
const outboxRepo = require("../repositories/outboxRepo");
const { createOutboxService } = require("../domain/services/outboxService");
const { ProviderRegistry } = require("../transport/providers/providerRegistry");
const { createChannelGateway } = require("../transport/providers/channelGateway");
const { createWhatsappAdapter } = require("../channels/whatsapp-web/whatsappAdapter");
const { createWhatsappMetaAdapter } = require("../channels/whatsapp-meta/whatsappMetaAdapter");
const {
  createWhatsappRuntimeHttpAdapter,
} = require("../channels/whatsapp-runtime-http/whatsappRuntimeHttpAdapter");
const {
  createDormantWhatsappAdapter,
} = require("../channels/whatsapp-web/dormantWhatsappRuntime");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function buildWorkerId() {
  return `outbox-worker:${os.hostname()}:${process.pid}`;
}

function createChannelGatewayForWorker() {
  const providerRegistry = new ProviderRegistry();
  const whatsappProvider = String(env.WHATSAPP_PROVIDER || "runtime-http").trim().toLowerCase();
  const internalWhatsappRuntimeEnabled = env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME;
  const externalWhatsappRuntimeEnabled = env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME;

  let whatsappAdapter;

  if (whatsappProvider === "meta") {
    whatsappAdapter = createWhatsappMetaAdapter({
      accessToken: env.META_ACCESS_TOKEN,
      phoneNumberId: env.META_PHONE_NUMBER_ID,
      wabaId: env.META_WABA_ID,
      apiVersion: env.META_API_VERSION,
      logger,
      channel: "whatsapp-web",
    });
  } else if (internalWhatsappRuntimeEnabled) {
    whatsappAdapter = createWhatsappAdapter({
      sessionRepo: providerSessionRepo,
      logger,
      qrTtlSeconds: env.WHATSAPP_QR_TTL_SECONDS,
      browserExecutablePath: env.WHATSAPP_BROWSER_EXECUTABLE_PATH,
    });
  } else if (externalWhatsappRuntimeEnabled) {
    whatsappAdapter = createWhatsappRuntimeHttpAdapter({
      runtimeBaseUrl: env.WHATSAPP_RUNTIME_BASE_URL,
      runtimeApiKey: env.WHATSAPP_RUNTIME_API_KEY,
      requestTimeoutMs: env.WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS,
      logger,
    });
  } else {
    whatsappAdapter = createDormantWhatsappAdapter({ logger });
  }

  providerRegistry.registerAdapter("whatsapp-web", whatsappAdapter);

  return createChannelGateway({
    providerRegistry,
    sessionRepo: providerSessionRepo,
    logger,
  });
}

async function run() {
  if (!env.OUTBOX_WORKER_ENABLED) {
    logger.warn("Outbox worker is disabled by configuration", {
      envKey: "OUTBOX_WORKER_ENABLED",
    });
    return;
  }

  const workerId = buildWorkerId();
  const channelGateway = createChannelGatewayForWorker();
  const outboxService = createOutboxService({
    outboxRepo,
    channelGateway,
    logger,
    inlineSendEnabled: false,
    defaultMaxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    retryBaseMs: env.OUTBOX_RETRY_BASE_MS,
    retryMaxMs: env.OUTBOX_RETRY_MAX_MS,
    leaseMs: env.OUTBOX_LEASE_MS,
  });

  let keepRunning = true;
  let idleCycles = 0;

  const stop = (signal) => {
    logger.info("Outbox worker stop requested", { workerId, signal });
    keepRunning = false;
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  logger.info("Outbox worker started", {
    workerId,
    pollMs: env.OUTBOX_WORKER_POLL_MS,
    batchSize: env.OUTBOX_WORKER_BATCH_SIZE,
    leaseMs: env.OUTBOX_LEASE_MS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });

  while (keepRunning) {
    let processedInCycle = 0;

    for (let index = 0; index < env.OUTBOX_WORKER_BATCH_SIZE; index += 1) {
      if (!keepRunning) {
        break;
      }

      const result = await outboxService.dispatchNextDueMessage({ workerId });
      if (!result.processed) {
        break;
      }

      processedInCycle += 1;
    }

    if (processedInCycle === 0) {
      idleCycles += 1;
      if (idleCycles % 40 === 0) {
        logger.info("Outbox worker idle", {
          workerId,
          idleCycles,
        });
      }
      await sleep(env.OUTBOX_WORKER_POLL_MS);
      continue;
    }

    idleCycles = 0;
  }

  logger.info("Outbox worker stopped", {
    workerId,
  });
}

run().catch((error) => {
  logger.error("Outbox worker crashed", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
