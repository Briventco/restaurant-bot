const crypto = require("crypto");

function hashString(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePayload(payload = {}) {
  return {
    restaurantId: String(payload.restaurantId || "").trim(),
    channel: String(payload.channel || "").trim(),
    recipient: String(payload.recipient || payload.to || "").trim(),
    text: String(payload.text || ""),
    messageType: String(payload.messageType || "generic").trim(),
    sourceAction: String(payload.sourceAction || "unknown").trim(),
    sourceRef: String(payload.sourceRef || "").trim(),
    idempotencyKey: String(payload.idempotencyKey || "").trim(),
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    maxAttempts: payload.maxAttempts,
  };
}

function validatePayload(payload) {
  if (!payload.restaurantId) {
    throw new Error("restaurantId is required");
  }
  if (!payload.channel) {
    throw new Error("channel is required");
  }
  if (!payload.recipient) {
    throw new Error("recipient is required");
  }
  if (!payload.text.trim()) {
    throw new Error("text is required");
  }
}

function buildFallbackIdempotencyKey(payload) {
  const textHash = hashString(payload.text);
  return [
    "outbound",
    payload.restaurantId,
    payload.channel,
    payload.recipient,
    payload.messageType,
    payload.sourceAction,
    payload.sourceRef || "none",
    textHash,
  ].join(":");
}

function buildPayloadHash(payload) {
  const source = {
    restaurantId: payload.restaurantId,
    channel: payload.channel,
    recipient: payload.recipient,
    text: payload.text,
    messageType: payload.messageType,
    sourceAction: payload.sourceAction,
    sourceRef: payload.sourceRef,
    metadata: payload.metadata,
  };

  return hashString(JSON.stringify(source));
}

function computeRetryDelayMs({ attemptNumber, retryBaseMs, retryMaxMs }) {
  const base = Math.max(250, toSafeNumber(retryBaseMs, 1_000));
  const max = Math.max(base, toSafeNumber(retryMaxMs, 60_000));
  const exponent = Math.max(0, toSafeNumber(attemptNumber, 1) - 1);
  const delay = base * 2 ** exponent;
  return clamp(delay, base, max);
}

function createOutboxService({
  outboxRepo,
  channelGateway,
  logger,
  inlineSendEnabled = true,
  defaultMaxAttempts = 5,
  retryBaseMs = 1_000,
  retryMaxMs = 60_000,
  leaseMs = 30_000,
}) {
  function buildWorkerId(prefix = "worker") {
    return `${prefix}:${process.pid}:${Date.now()}`;
  }

  async function enqueueOutboundMessage(rawPayload) {
    const payload = normalizePayload(rawPayload);
    validatePayload(payload);

    const idempotencyKey = payload.idempotencyKey || buildFallbackIdempotencyKey(payload);
    const idempotencyHash = hashString(idempotencyKey);
    const messageId = idempotencyHash;
    const nowMs = Date.now();

    const maxAttempts = clamp(
      toSafeNumber(payload.maxAttempts, defaultMaxAttempts),
      1,
      20
    );

    const result = await outboxRepo.createOutboxMessageIfAbsent({
      messageId,
      idempotencyKey,
      idempotencyHash,
      payloadHash: buildPayloadHash(payload),
      restaurantId: payload.restaurantId,
      channel: payload.channel,
      recipient: payload.recipient,
      text: payload.text,
      messageType: payload.messageType,
      sourceAction: payload.sourceAction,
      sourceRef: payload.sourceRef,
      metadata: payload.metadata,
      nowMs,
      maxAttempts,
    });

    return {
      message: result.message,
      created: Boolean(result.created),
      duplicate: Boolean(result.duplicate),
    };
  }

  async function dispatchClaimedMessage(claimedMessage, workerId) {
    const nowMs = Date.now();
    try {
      const response = await channelGateway.sendMessage({
        channel: claimedMessage.channel,
        restaurantId: claimedMessage.restaurantId,
        to: claimedMessage.recipient,
        text: claimedMessage.text,
        metadata: {
          ...(claimedMessage.metadata || {}),
          outboxMessageId: claimedMessage.id,
          outboxAttempt: toSafeNumber(claimedMessage.attemptCount, 0) + 1,
        },
      });

      const providerMessageId =
        (response && response.providerMessageId) ||
        (response && response.messageId) ||
        "";

      const updated = await outboxRepo.markOutboxMessageSent({
        messageId: claimedMessage.id,
        workerId,
        nowMs,
        providerMessageId,
        providerResponse: response || {},
      });

      return {
        processed: true,
        message: updated || claimedMessage,
      };
    } catch (error) {
      const currentAttemptNumber = toSafeNumber(claimedMessage.attemptCount, 0) + 1;
      const delayMs = computeRetryDelayMs({
        attemptNumber: currentAttemptNumber,
        retryBaseMs,
        retryMaxMs,
      });
      const retryAtMs = nowMs + delayMs;
      const isRetryable = error && error.retryable !== false;
      const maxAttemptsForFailure = isRetryable
        ? toSafeNumber(claimedMessage.maxAttempts, defaultMaxAttempts)
        : currentAttemptNumber;

      const updated = await outboxRepo.markOutboxMessageFailure({
        messageId: claimedMessage.id,
        workerId,
        nowMs,
        retryAtMs,
        maxAttempts: maxAttemptsForFailure,
        error,
      });

      logger.warn("Outbound outbox send failed", {
        messageId: claimedMessage.id,
        restaurantId: claimedMessage.restaurantId,
        channel: claimedMessage.channel,
        recipient: claimedMessage.recipient,
        messageType: claimedMessage.messageType,
        sourceAction: claimedMessage.sourceAction,
        attemptNumber: currentAttemptNumber,
        nextAttemptAtMs: retryAtMs,
        retryable: isRetryable,
        code: error.code || "",
        error: error.message,
      });

      return {
        processed: true,
        message: updated || claimedMessage,
      };
    }
  }

  async function dispatchByMessageId({
    messageId,
    workerId = buildWorkerId("inline"),
  }) {
    const claimed = await outboxRepo.claimOutboxMessageById({
      messageId,
      workerId,
      nowMs: Date.now(),
      leaseMs,
    });

    if (!claimed) {
      return {
        processed: false,
        reason: "not_claimed",
      };
    }

    return dispatchClaimedMessage(claimed, workerId);
  }

  async function dispatchNextDueMessage({
    workerId = buildWorkerId("outbox-worker"),
  } = {}) {
    const claimed = await outboxRepo.claimNextDueOutboxMessage({
      workerId,
      nowMs: Date.now(),
      leaseMs,
    });

    if (!claimed) {
      return {
        processed: false,
        reason: "no_due_message",
      };
    }

    return dispatchClaimedMessage(claimed, workerId);
  }

  async function enqueueAndMaybeDispatch(rawPayload) {
    const enqueueResult = await enqueueOutboundMessage(rawPayload);
    const inlineEnabled = rawPayload.inlineSendEnabled !== undefined
      ? Boolean(rawPayload.inlineSendEnabled)
      : Boolean(inlineSendEnabled);

    if (!inlineEnabled) {
      return {
        ...enqueueResult,
        inlineDispatched: false,
        message: enqueueResult.message,
      };
    }

    const dispatchResult = await dispatchByMessageId({
      messageId: enqueueResult.message.id,
      workerId: buildWorkerId("inline"),
    });

    if (!dispatchResult.processed) {
      const latest = await outboxRepo.getOutboxMessageById(enqueueResult.message.id);
      return {
        ...enqueueResult,
        inlineDispatched: false,
        message: latest || enqueueResult.message,
      };
    }

    return {
      ...enqueueResult,
      inlineDispatched: true,
      message: dispatchResult.message || enqueueResult.message,
    };
  }

  async function getOutboxMessageById(messageId) {
    return outboxRepo.getOutboxMessageById(messageId);
  }

  async function listOutboxMessages({ restaurantId, status, limit }) {
    return outboxRepo.listOutboxMessagesByRestaurant({
      restaurantId,
      status,
      limit,
    });
  }

  async function getOutboxStats(restaurantId) {
    return outboxRepo.getOutboxStatsByRestaurant(restaurantId);
  }

  async function retryOutboxMessage({ restaurantId, messageId, requestedBy }) {
    return outboxRepo.retryOutboxMessage({
      restaurantId,
      messageId,
      requestedBy,
      nowMs: Date.now(),
    });
  }

  return {
    enqueueOutboundMessage,
    enqueueAndMaybeDispatch,
    dispatchByMessageId,
    dispatchNextDueMessage,
    getOutboxMessageById,
    listOutboxMessages,
    getOutboxStats,
    retryOutboxMessage,
    computeRetryDelayMs,
  };
}

module.exports = {
  createOutboxService,
  computeRetryDelayMs,
  buildFallbackIdempotencyKey,
};
