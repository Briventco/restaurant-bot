const qrcode = require("qrcode-terminal");
const fs = require("node:fs");
const path = require("node:path");

const { createLogger } = require("../utils/logger");
const { createWhatsappClient } = require("../client/createWhatsappClient");
const { createSafeSender } = require("../client/safeSender");
const { normalizeInboundMessage } = require("../utils/messageNormalizer");
const { shouldIgnoreNormalizedMessage } = require("../utils/messageFilters");
const { createInMemoryDedupeStore } = require("../utils/inMemoryDedupeStore");
const { createInMemoryIdempotencyStore } = require("../utils/inMemoryIdempotencyStore");
const { createChatQueue } = require("../utils/chatQueue");
const { createBackendInboundService } = require("../services/backendInboundService");
const { createInboundPipeline } = require("../handlers/createInboundPipeline");
const { getProcessMemorySnapshot } = require("../utils/memory");
const { requiresManualReauthentication } = require("./sessionFailurePolicy");

function createRetryableError(code, message, retryable = true) {
  const error = new Error(message);
  error.code = code;
  error.retryable = Boolean(retryable);
  return error;
}

function nowMs() {
  return Date.now();
}

function toSafeMessage(value, maxLength = 500) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, maxLength);
}

function computeBackoffMs(attempt, reconnectConfig) {
  const baseDelayMs = Math.max(1000, Number(reconnectConfig.baseDelayMs || 5000));
  const maxDelayMs = Math.max(baseDelayMs, Number(reconnectConfig.maxDelayMs || 120000));
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  const calculated = baseDelayMs * 2 ** exponent;
  return Math.min(maxDelayMs, calculated);
}

function createTenantRuntime({
  tenantConfig,
  constants,
  runtimeInstanceId,
  parentLogger,
}) {
  const logger = parentLogger || createLogger(`whatsapp-bot:${tenantConfig.restaurantId}`);
  const ATTENTION_STATUSES = new Set(["paused", "disconnected", "error", "disabled"]);

  const state = {
    status: tenantConfig.enabled ? "starting" : "disabled",
    disabledReason: tenantConfig.enabled
      ? ""
      : tenantConfig.disabledReason || "tenant_disabled_in_config",
    pausedReason: "",
    lastHeartbeat: nowMs(),
    lastConnectedAt: 0,
    lastDisconnectReason: "",
    reconnectAttemptCount: 0,
    lastErrorAt: 0,
    lastErrorCode: "",
    lastErrorMessage: "",
    lastQrAt: 0,
    qrAvailable: false,
    qr: null,
    qrGenerationCount: 0,
    qrRegenerationCount: 0,
    inboundQueueSize: 0,
    outboundQueueSize: 0,
    browserLaunchCount: 0,
    browserLaunchFailureCount: 0,
    browserLaunchInFlight: false,
    lastBrowserLaunchAt: 0,
    lastBrowserLaunchError: "",
    disconnectCount: 0,
    reconnectScheduleCount: 0,
    reconnectLastDelayMs: 0,
    reconnectLastReason: "",
    authStorageLastCheckedAt: 0,
    authStorageWritable: false,
    authSessionExists: false,
    authSessionFileCount: 0,
  };

  let paused = false;
  let stopped = false;
  let starting = false;
  let client = null;
  let shuttingDownClient = false;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let outboundQueue = Promise.resolve();
  let outboundQueuePending = 0;
  let outboundInFlight = 0;

  const authDataPath = path.isAbsolute(constants.WHATSAPP_AUTH_DATA_PATH)
    ? constants.WHATSAPP_AUTH_DATA_PATH
    : path.resolve(process.cwd(), constants.WHATSAPP_AUTH_DATA_PATH || ".wwebjs_auth");
  const authSessionPath = path.join(authDataPath, `session-${tenantConfig.whatsappClientId}`);

  const dedupeStore = createInMemoryDedupeStore({
    ttlMs: constants.INBOUND_DEDUPE_TTL_MS,
    maxEntries: constants.INBOUND_DEDUPE_MAX_ENTRIES,
  });

  const replyDedupeStore = createInMemoryDedupeStore({
    ttlMs: constants.OUTBOUND_DEDUPE_TTL_MS,
    maxEntries: constants.OUTBOUND_DEDUPE_MAX_ENTRIES,
  });

  const outboundIdempotencyStore = createInMemoryIdempotencyStore({
    inFlightTtlMs: constants.BOT_RUNTIME_OUTBOUND_INFLIGHT_TTL_MS,
    sentTtlMs: constants.BOT_RUNTIME_OUTBOUND_SENT_TTL_MS,
    failedTtlMs: constants.BOT_RUNTIME_OUTBOUND_FAILED_TTL_MS,
    maxEntries: 30000,
  });

  const chatQueue = createChatQueue();

  const tenantConstants = {
    ...constants,
    BOT_ENABLED: true,
    BOT_ALLOW_ALL_CHATS: Boolean(tenantConfig.allowAllChats),
    ALLOWED_CHAT_IDS: new Set(tenantConfig.allowedChatIds || []),
    ALLOWED_PHONE_PREFIXES: tenantConfig.allowedPhonePrefixes || [],
    IGNORE_GROUP_CHATS: tenantConfig.ignoreGroupChats !== false,
  };

  const messageService = createBackendInboundService({
    backendBaseUrl: tenantConfig.backendApiBaseUrl,
    backendApiPrefix: constants.BACKEND_API_PREFIX,
    restaurantId: tenantConfig.restaurantId,
    apiKey: tenantConfig.backendApiKey,
    requestTimeoutMs: constants.BACKEND_REQUEST_TIMEOUT_MS,
    logger,
  });

  function inspectAuthStorage() {
    const checkedAt = nowMs();
    let writable = false;
    let sessionExists = false;
    let fileCount = 0;

    try {
      fs.mkdirSync(authDataPath, { recursive: true });
      fs.accessSync(authDataPath, fs.constants.W_OK);
      writable = true;
    } catch (_error) {
      writable = false;
    }

    try {
      sessionExists = fs.existsSync(authSessionPath);
      if (sessionExists) {
        fileCount = fs.readdirSync(authSessionPath).length;
      }
    } catch (_error) {
      sessionExists = false;
      fileCount = 0;
    }

    state.authStorageLastCheckedAt = checkedAt;
    state.authStorageWritable = writable;
    state.authSessionExists = sessionExists;
    state.authSessionFileCount = fileCount;
  }

  function updateHeartbeat() {
    state.lastHeartbeat = nowMs();
    state.inboundQueueSize = chatQueue.size();
    state.outboundQueueSize = outboundQueuePending + outboundInFlight;
  }

  function setStatus(nextStatus) {
    const previousStatus = state.status;
    state.status = nextStatus;
    updateHeartbeat();

    if (previousStatus !== nextStatus) {
      logger.info("Tenant status changed", {
        restaurantId: tenantConfig.restaurantId,
        fromStatus: previousStatus,
        toStatus: nextStatus,
        disabledReason: state.disabledReason || "",
        pausedReason: state.pausedReason || "",
        lastDisconnectReason: state.lastDisconnectReason || "",
        reconnectAttemptCount: state.reconnectAttemptCount,
        reconnectScheduled: Boolean(reconnectTimer),
        memory: getProcessMemorySnapshot(),
      });
    }
  }

  function setError(error) {
    state.lastErrorAt = nowMs();
    state.lastErrorCode = String((error && error.code) || "");
    state.lastErrorMessage = toSafeMessage(
      (error && error.message) || "tenant_runtime_error"
    );
    state.lastBrowserLaunchError = state.lastErrorMessage;
    if (error) {
      logger.error("Tenant runtime error", {
        restaurantId: tenantConfig.restaurantId,
        status: state.status,
        code: error.code || "",
        message: toSafeMessage(error.message || String(error), 800),
        memory: getProcessMemorySnapshot(),
      });
    }
  }

  function setQr(qr) {
    const qrValue = String(qr || "").trim();
    if (!qrValue) {
      return {
        changed: false,
        duplicate: false,
      };
    }

    const generatedAt = nowMs();
    const expiresAt = generatedAt + Math.max(30000, Number(constants.BOT_RUNTIME_QR_TTL_MS || 120000));
    const duplicate = Boolean(state.qr && state.qr.value === qrValue);
    state.qr = {
      value: qrValue,
      generatedAt,
      expiresAt,
    };
    state.qrGenerationCount += 1;
    if (duplicate) {
      state.qrRegenerationCount += 1;
    }
    state.qrAvailable = true;
    state.lastQrAt = generatedAt;
    state.lastHeartbeat = generatedAt;
    inspectAuthStorage();
    return {
      changed: !duplicate,
      duplicate,
    };
  }

  function clearQr() {
    state.qr = null;
    state.qrAvailable = false;
    updateHeartbeat();
  }

  function getQrSnapshot() {
    if (!state.qr) {
      return null;
    }
    if (Number(state.qr.expiresAt || 0) <= nowMs()) {
      clearQr();
      return null;
    }
    return {
      qr: state.qr.value,
      generatedAtMs: state.qr.generatedAt,
      expiresAtMs: state.qr.expiresAt,
    };
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function pauseForReauthentication(reason, source = "runtime_reauth_required") {
    paused = true;
    clearReconnectTimer();
    clearQr();
    state.pausedReason = "reauthentication_required";
    state.lastDisconnectReason = String(reason || source || "reauthentication_required");
    setStatus("paused");
    logger.warn("Tenant paused pending re-authentication", {
      restaurantId: tenantConfig.restaurantId,
      source,
      reason: state.lastDisconnectReason,
      authSessionExists: state.authSessionExists,
      authSessionFileCount: state.authSessionFileCount,
      memory: getProcessMemorySnapshot(),
    });
  }

  function scheduleReconnect(reason) {
    if (paused || stopped || !tenantConfig.enabled) {
      return;
    }

    if (reconnectTimer) {
      logger.warn("Reconnect already scheduled; skipping duplicate schedule", {
        restaurantId: tenantConfig.restaurantId,
        reconnectAttemptCount: state.reconnectAttemptCount,
        pendingReason: state.reconnectLastReason || "",
        incomingReason: String(reason || ""),
      });
      return;
    }

    state.reconnectAttemptCount += 1;
    const tenantMaxAttempts = Number(tenantConfig.reconnect.maxAttemptsBeforePause || 20);
    const globalCap = Number(constants.BOT_RUNTIME_RECONNECT_MAX_ATTEMPTS || tenantMaxAttempts);
    const maxAttempts = Math.max(1, Math.min(tenantMaxAttempts, globalCap));
    if (state.reconnectAttemptCount > maxAttempts) {
      paused = true;
      state.pausedReason = "reconnect_attempts_exhausted";
      setStatus("paused");
      logger.warn("Tenant paused due to reconnect exhaustion", {
        restaurantId: tenantConfig.restaurantId,
        reconnectAttemptCount: state.reconnectAttemptCount,
        reason,
      });
      return;
    }

    const delayMs = Math.max(
      computeBackoffMs(state.reconnectAttemptCount, tenantConfig.reconnect),
      Math.max(1000, Number(constants.BOT_RUNTIME_MIN_RESTART_GAP_MS || 3000))
    );
    state.reconnectScheduleCount += 1;
    state.reconnectLastDelayMs = delayMs;
    state.reconnectLastReason = String(reason || "");
    setStatus("reconnecting");
    logger.warn("Tenant reconnect scheduled", {
      restaurantId: tenantConfig.restaurantId,
      reconnectAttemptCount: state.reconnectAttemptCount,
      maxAttempts,
      delayMs,
      reason,
      memory: getProcessMemorySnapshot(),
    });

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void start(`auto_reconnect_${state.reconnectAttemptCount}`);
    }, delayMs);
  }

  function enqueueOutboundTask(task) {
    outboundQueuePending += 1;
    updateHeartbeat();

    const run = async () => {
      outboundQueuePending = Math.max(0, outboundQueuePending - 1);
      outboundInFlight += 1;
      updateHeartbeat();

      try {
        return await task();
      } finally {
        outboundInFlight = Math.max(0, outboundInFlight - 1);
        updateHeartbeat();
      }
    };

    const next = outboundQueue.catch(() => undefined).then(run);
    outboundQueue = next;
    return next;
  }

  const safeSender = createSafeSender({
    client: {
      sendMessage: (...args) => client.sendMessage(...args),
    },
    logger,
    sendDelayMs: constants.SEND_DELAY_MS,
    retryAttempts: constants.SEND_RETRY_ATTEMPTS,
    retryBackoffMs: constants.SEND_RETRY_BACKOFF_MS,
  });

  const inboundPipeline = createInboundPipeline({
    normalizeInboundMessage,
    shouldIgnoreNormalizedMessage,
    dedupeStore,
    replyDedupeStore,
    chatQueue,
    messageService,
    sendText: async (chatId, text) => enqueueOutboundTask(() => safeSender.sendText(chatId, text)),
    constants: tenantConstants,
    logger,
  });

  function bindClientEvents(localClient) {
    localClient.on("qr", (qr) => {
      if (!tenantConfig.enabled || paused || stopped || shuttingDownClient) {
        return;
      }
      const qrUpdate = setQr(qr);
      setStatus("qr_required");
      const shouldLogDuplicate =
        !qrUpdate.changed && state.qrRegenerationCount % 5 === 0;
      if (qrUpdate.changed || shouldLogDuplicate) {
        logger.info(
          qrUpdate.changed
            ? "Tenant QR generated"
            : "Tenant QR regenerated (duplicate payload)",
          {
            restaurantId: tenantConfig.restaurantId,
            qrGenerationCount: state.qrGenerationCount,
            qrRegenerationCount: state.qrRegenerationCount,
            memory: getProcessMemorySnapshot(),
          }
        );
      }
      if (constants.BOT_PRINT_TERMINAL_QR && qrUpdate.changed) {
        qrcode.generate(qr, { small: true });
      }
    });

    localClient.on("authenticated", () => {
      if (!tenantConfig.enabled || paused || stopped || shuttingDownClient) {
        return;
      }
      clearQr();
      inspectAuthStorage();
      setStatus("authenticating");
      logger.info("Tenant authenticated", {
        restaurantId: tenantConfig.restaurantId,
        authSessionExists: state.authSessionExists,
        authSessionFileCount: state.authSessionFileCount,
      });
    });

    localClient.on("ready", () => {
      if (!tenantConfig.enabled || paused || stopped || shuttingDownClient) {
        return;
      }
      clearQr();
      inspectAuthStorage();
      state.lastConnectedAt = nowMs();
      state.reconnectAttemptCount = 0;
      state.lastDisconnectReason = "";
      state.lastErrorAt = 0;
      state.lastErrorCode = "";
      state.lastErrorMessage = "";
      state.browserLaunchInFlight = false;
      state.lastBrowserLaunchError = "";
      setStatus("connected");
      logger.info("Tenant WhatsApp client ready", {
        restaurantId: tenantConfig.restaurantId,
        authSessionExists: state.authSessionExists,
        authSessionFileCount: state.authSessionFileCount,
        memory: getProcessMemorySnapshot(),
      });
    });

    localClient.on("disconnected", (reason) => {
      if (shuttingDownClient || stopped || paused) {
        return;
      }
      state.disconnectCount += 1;
      state.lastDisconnectReason = String(reason || "unknown_disconnect");
      clearQr();
      setStatus("disconnected");
      logger.warn("Tenant WhatsApp client disconnected", {
        restaurantId: tenantConfig.restaurantId,
        reason: state.lastDisconnectReason,
        disconnectCount: state.disconnectCount,
        memory: getProcessMemorySnapshot(),
      });
      if (requiresManualReauthentication(state.lastDisconnectReason)) {
        void destroyClient("event_disconnected_terminal", { suppressError: true })
          .finally(() => {
            pauseForReauthentication(state.lastDisconnectReason, "disconnected");
          });
        return;
      }
      void destroyClient("event_disconnected", { suppressError: true })
        .finally(() => {
          scheduleReconnect(state.lastDisconnectReason);
        });
    });

    localClient.on("auth_failure", (message) => {
      if (shuttingDownClient || stopped || paused) {
        return;
      }
      state.disconnectCount += 1;
      state.lastDisconnectReason = String(message || "auth_failure");
      setError(createRetryableError("AUTH_FAILURE", state.lastDisconnectReason, false));
      void destroyClient("event_auth_failure", { suppressError: true })
        .finally(() => {
          pauseForReauthentication(state.lastDisconnectReason, "auth_failure");
        });
    });

    localClient.on("message", async (rawMessage) => {
      try {
        await inboundPipeline.handleRawMessage(rawMessage);
      } catch (error) {
        setError(error);
        logger.error("Tenant inbound handler failed", {
          restaurantId: tenantConfig.restaurantId,
          message: error.message,
        });
      }
    });
  }

  async function ensureClient() {
    if (client) {
      return client;
    }

    inspectAuthStorage();

    client = createWhatsappClient({
      clientId: tenantConfig.whatsappClientId,
      protocolTimeoutMs: constants.PUPPETEER_PROTOCOL_TIMEOUT_MS,
      puppeteerArgs: constants.PUPPETEER_ARGS,
      puppeteerHeadless: constants.PUPPETEER_HEADLESS,
      puppeteerExecutablePath: constants.PUPPETEER_EXECUTABLE_PATH,
      authDataPath,
      logger,
    });

    bindClientEvents(client);
    return client;
  }

  async function start(reason = "manual_start") {
    if (!tenantConfig.enabled) {
      state.disabledReason = tenantConfig.disabledReason || "tenant_disabled_in_config";
      setStatus("disabled");
      return;
    }

    if (paused) {
      setStatus("paused");
      return;
    }

    if (starting) {
      return;
    }

    if (
      client &&
      ["connected", "authenticating", "qr_required", "starting"].includes(
        String(state.status || "")
      )
    ) {
      logger.info("Tenant start skipped because client is already active", {
        restaurantId: tenantConfig.restaurantId,
        status: state.status,
        reason,
      });
      return;
    }

    starting = true;
    clearReconnectTimer();
    setStatus("starting");
    inspectAuthStorage();
    state.browserLaunchCount += 1;
    state.browserLaunchInFlight = true;
    state.lastBrowserLaunchAt = nowMs();
    logger.info("Tenant runtime starting", {
      restaurantId: tenantConfig.restaurantId,
      reason,
      browserLaunchCount: state.browserLaunchCount,
      authDataPath,
      authSessionPath,
      authStorageWritable: state.authStorageWritable,
      authSessionExists: state.authSessionExists,
      memory: getProcessMemorySnapshot(),
    });

    try {
      const localClient = await ensureClient();
      logger.info("Launching tenant browser", {
        restaurantId: tenantConfig.restaurantId,
        whatsappClientId: tenantConfig.whatsappClientId,
      });
      await localClient.initialize();
      logger.info("Tenant client initialize invoked", {
        restaurantId: tenantConfig.restaurantId,
      });
    } catch (error) {
      state.browserLaunchFailureCount += 1;
      state.lastBrowserLaunchError = toSafeMessage(error && error.message ? error.message : "");
      await destroyClient("start_failed", { suppressError: true });
      setError(error);
      setStatus("error");
      scheduleReconnect("start_failed");
    } finally {
      state.browserLaunchInFlight = false;
      starting = false;
    }
  }

  async function destroyClient(reason = "manual_destroy", options = {}) {
    const suppressError = Boolean(options.suppressError);
    if (!client) {
      return;
    }

    if (shuttingDownClient) {
      return;
    }

    const localClient = client;
    client = null;
    shuttingDownClient = true;
    try {
      await localClient.destroy();
      logger.info("Tenant client destroyed", {
        restaurantId: tenantConfig.restaurantId,
        reason,
      });
    } catch (error) {
      if (!suppressError) {
        setError(error);
      }
    } finally {
      shuttingDownClient = false;
    }
  }

  async function pause(reason = "manual_pause") {
    paused = true;
    state.pausedReason = String(reason || "manual_pause");
    clearReconnectTimer();
    await destroyClient("pause");
    clearQr();
    setStatus("paused");
    logger.warn("Tenant paused", {
      restaurantId: tenantConfig.restaurantId,
      pausedReason: state.pausedReason,
    });
  }

  async function resume(reason = "manual_resume") {
    if (!tenantConfig.enabled) {
      state.disabledReason = tenantConfig.disabledReason || "tenant_disabled_in_config";
      setStatus("disabled");
      return;
    }

    paused = false;
    state.pausedReason = "";
    logger.info("Tenant resumed", {
      restaurantId: tenantConfig.restaurantId,
      reason,
    });
    await start(reason);
  }

  async function restart(reason = "manual_restart") {
    logger.warn("Tenant restart requested", {
      restaurantId: tenantConfig.restaurantId,
      reason,
    });
    paused = false;
    state.pausedReason = "";
    clearReconnectTimer();
    await destroyClient("restart");
    clearQr();
    await start(reason);
  }

  async function stop(reason = "shutdown") {
    stopped = true;
    clearReconnectTimer();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    await destroyClient("stop");
    clearQr();
    setStatus("disconnected");
    logger.info("Tenant runtime stopped", {
      restaurantId: tenantConfig.restaurantId,
      reason,
    });
  }

  async function sendOutbound(payload = {}) {
    const outboxMessageId = String(payload.outboxMessageId || "").trim();
    const to = String(payload.to || "").trim();
    const text = String(payload.text || "");

    if (!outboxMessageId) {
      throw createRetryableError("INVALID_PAYLOAD", "outboxMessageId is required", false);
    }
    if (!to) {
      throw createRetryableError("INVALID_PAYLOAD", "Recipient is required", false);
    }
    if (!text.trim()) {
      throw createRetryableError("INVALID_PAYLOAD", "Message text is required", false);
    }

    if (!tenantConfig.enabled) {
      throw createRetryableError(
        "TENANT_DISABLED",
        state.disabledReason || "Tenant is disabled",
        false
      );
    }

    if (paused) {
      throw createRetryableError(
        "TENANT_PAUSED",
        state.pausedReason || "Tenant is paused",
        false
      );
    }

    if (state.status !== "connected") {
      throw createRetryableError(
        "TENANT_NOT_CONNECTED",
        `Tenant is not connected (status=${state.status})`,
        true
      );
    }

    const begin = outboundIdempotencyStore.begin(outboxMessageId, nowMs());
    if (!begin.ok) {
      if (begin.reason === "already_sent") {
        return {
          accepted: true,
          status: "already_sent",
          deduped: true,
          outboxMessageId,
          handledByRuntimeInstance: runtimeInstanceId,
          tenantStatus: state.status,
          sentAtMs: begin.record && begin.record.updatedAtMs ? begin.record.updatedAtMs : 0,
          providerMessageId:
            begin.record &&
            begin.record.result &&
            begin.record.result.providerMessageId
              ? begin.record.result.providerMessageId
              : "",
          inboundQueueSize: chatQueue.size(),
          outboundQueueSize: outboundQueuePending + outboundInFlight,
        };
      }

      if (begin.reason === "in_flight") {
        return {
          accepted: true,
          status: "in_flight",
          deduped: true,
          outboxMessageId,
          handledByRuntimeInstance: runtimeInstanceId,
          tenantStatus: state.status,
          inboundQueueSize: chatQueue.size(),
          outboundQueueSize: outboundQueuePending + outboundInFlight,
        };
      }
    }

    const timeoutMs = Math.max(
      1000,
      Number(constants.BOT_RUNTIME_SEND_TIMEOUT_MS || 12000)
    );
    const sendPromise = enqueueOutboundTask(async () => safeSender.sendText(to, text));
    let timeoutHandle = null;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          createRetryableError(
            "OUTBOUND_SEND_TIMEOUT",
            "Tenant outbound send timed out",
            true
          )
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([sendPromise, timeoutPromise]);
      const sentAtMs = nowMs();
      const sentRecord = outboundIdempotencyStore.markSent(
        outboxMessageId,
        {
          providerMessageId: "",
          sentAtMs,
        },
        sentAtMs
      );

      return {
        accepted: true,
        status: "sent",
        deduped: false,
        outboxMessageId,
        handledByRuntimeInstance: runtimeInstanceId,
        tenantStatus: state.status,
        providerMessageId: "",
        sentAtMs,
        inboundQueueSize: chatQueue.size(),
        outboundQueueSize: outboundQueuePending + outboundInFlight,
        idempotencyRecordUpdatedAtMs: sentRecord ? sentRecord.updatedAtMs : sentAtMs,
      };
    } catch (error) {
      if (error && error.code === "OUTBOUND_SEND_TIMEOUT") {
        setError(error);

        sendPromise
          .then(() => {
            const lateSentAtMs = nowMs();
            outboundIdempotencyStore.markSent(
              outboxMessageId,
              {
                providerMessageId: "",
                sentAtMs: lateSentAtMs,
              },
              lateSentAtMs
            );
          })
          .catch((lateError) => {
            outboundIdempotencyStore.markFailed(
              outboxMessageId,
              {
                code: String((lateError && lateError.code) || ""),
                message: String(
                  (lateError && lateError.message) ||
                    "runtime_send_failed_after_timeout"
                ),
                retryable: lateError && lateError.retryable !== false,
              },
              nowMs()
            );
            setError(lateError);
          });

        throw error;
      }

      outboundIdempotencyStore.markFailed(
        outboxMessageId,
        {
          code: String((error && error.code) || ""),
          message: String((error && error.message) || "runtime_send_failed"),
          retryable: error && error.retryable !== false,
        },
        nowMs()
      );
      setError(error);
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  function getStatusSnapshot() {
    const qrSnapshot = getQrSnapshot();
    const status = state.status;
    const disabledReason = status === "disabled" ? state.disabledReason || "tenant_disabled" : "";
    const pausedReason = status === "paused" ? state.pausedReason || "tenant_paused" : "";
    const statusDetail = (() => {
      if (status === "disabled") {
        return disabledReason;
      }
      if (status === "paused") {
        return pausedReason;
      }
      if (status === "disconnected") {
        return state.lastDisconnectReason || "tenant_disconnected";
      }
      if (status === "error") {
        return state.lastErrorMessage || state.lastDisconnectReason || "tenant_error";
      }
      return "";
    })();

    updateHeartbeat();
    inspectAuthStorage();

    return {
      restaurantId: tenantConfig.restaurantId,
      runtimeInstanceId,
      status,
      enabled: tenantConfig.enabled,
      disabledReason,
      pausedReason,
      lastHeartbeat: state.lastHeartbeat,
      lastConnectedAt: state.lastConnectedAt,
      lastDisconnectReason: state.lastDisconnectReason,
      reconnectAttemptCount: state.reconnectAttemptCount,
      inboundQueueSize: chatQueue.size(),
      outboundQueueSize: outboundQueuePending + outboundInFlight,
      qrAvailable: Boolean(qrSnapshot),
      lastErrorAt: state.lastErrorAt,
      lastErrorCode: state.lastErrorCode,
      lastErrorMessage: state.lastErrorMessage,
      lastQrAt: state.lastQrAt,
      needsAttention: ATTENTION_STATUSES.has(status),
      statusDetail,
      reconnectScheduled: Boolean(reconnectTimer),
      reconnectLastDelayMs: state.reconnectLastDelayMs,
      reconnectLastReason: state.reconnectLastReason,
      clientReady: status === "connected",
      whatsappClientId: tenantConfig.whatsappClientId,
      qrGenerationCount: state.qrGenerationCount,
      qrRegenerationCount: state.qrRegenerationCount,
      browserLaunchCount: state.browserLaunchCount,
      browserLaunchFailureCount: state.browserLaunchFailureCount,
      browserLaunchInFlight: state.browserLaunchInFlight,
      lastBrowserLaunchAt: state.lastBrowserLaunchAt,
      lastBrowserLaunchError: state.lastBrowserLaunchError,
      disconnectCount: state.disconnectCount,
      reconnectScheduleCount: state.reconnectScheduleCount,
      authDataPath,
      authSessionPath,
      authStorageWritable: state.authStorageWritable,
      authSessionExists: state.authSessionExists,
      authSessionFileCount: state.authSessionFileCount,
      authStorageLastCheckedAt: state.authStorageLastCheckedAt,
      processMemory: getProcessMemorySnapshot(),
    };
  }

  function getQr() {
    return getQrSnapshot();
  }

  function initializeHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }

    heartbeatTimer = setInterval(() => {
      updateHeartbeat();
    }, Math.max(5000, Number(constants.BOT_RUNTIME_HEARTBEAT_MS || 15000)));
  }

  initializeHeartbeat();
  inspectAuthStorage();

  function getDiagnostics() {
    return {
      status: getStatusSnapshot(),
      stores: {
        inboundDedupeSize: dedupeStore.size(),
        outboundReplyDedupeSize: replyDedupeStore.size(),
        outboundIdempotencySize: outboundIdempotencyStore.size(),
      },
      queues: {
        inboundQueueSize: chatQueue.size(),
        outboundQueueSize: outboundQueuePending + outboundInFlight,
      },
    };
  }

  return {
    tenantConfig,
    start,
    pause,
    resume,
    restart,
    stop,
    sendOutbound,
    getStatusSnapshot,
    getQr,
    getDiagnostics,
  };
}

module.exports = {
  createTenantRuntime,
  createRetryableError,
};
