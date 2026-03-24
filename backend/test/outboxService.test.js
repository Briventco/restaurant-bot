const test = require("node:test");
const assert = require("node:assert/strict");

const { createOutboxService } = require("../src/domain/services/outboxService");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createInMemoryOutboxRepo() {
  const store = new Map();

  function get(messageId) {
    const record = store.get(messageId);
    return record ? clone(record) : null;
  }

  function set(messageId, value) {
    store.set(messageId, clone(value));
  }

  function appendLifecycle(record, event) {
    const lifecycle = Array.isArray(record.lifecycle) ? record.lifecycle.slice() : [];
    lifecycle.push(event);
    record.lifecycle = lifecycle;
  }

  return {
    async createOutboxMessageIfAbsent(payload) {
      const existing = get(payload.messageId);
      if (existing) {
        if (existing.payloadHash !== payload.payloadHash) {
          const error = new Error("Idempotency key conflict: payload hash mismatch");
          error.statusCode = 409;
          throw error;
        }

        return {
          message: existing,
          created: false,
          duplicate: true,
        };
      }

      const doc = {
        id: payload.messageId,
        messageId: payload.messageId,
        idempotencyKey: payload.idempotencyKey,
        idempotencyHash: payload.idempotencyHash,
        payloadHash: payload.payloadHash,
        restaurantId: payload.restaurantId,
        channel: payload.channel,
        recipient: payload.recipient,
        text: payload.text,
        messageType: payload.messageType,
        sourceAction: payload.sourceAction,
        sourceRef: payload.sourceRef || "",
        metadata: payload.metadata || {},
        status: "queued",
        attemptCount: 0,
        maxAttempts: payload.maxAttempts || 5,
        nextAttemptAtMs: payload.nowMs || Date.now(),
        leaseOwner: "",
        leaseExpiresAtMs: 0,
        lastError: null,
        lifecycle: [],
      };

      appendLifecycle(doc, {
        toStatus: "queued",
      });

      set(payload.messageId, doc);

      return {
        message: get(payload.messageId),
        created: true,
        duplicate: false,
      };
    },

    async claimOutboxMessageById({ messageId, workerId, nowMs, leaseMs }) {
      const record = get(messageId);
      if (!record) {
        return null;
      }

      if (record.status === "sent" || record.status === "failed") {
        return null;
      }

      if (Number(record.nextAttemptAtMs || 0) > nowMs) {
        return null;
      }

      if (
        record.status === "processing" &&
        record.leaseOwner &&
        record.leaseOwner !== workerId &&
        Number(record.leaseExpiresAtMs || 0) > nowMs
      ) {
        return null;
      }

      record.status = "processing";
      record.leaseOwner = workerId;
      record.leaseExpiresAtMs = nowMs + (leaseMs || 30_000);
      appendLifecycle(record, {
        toStatus: "processing",
        actor: workerId,
      });
      set(messageId, record);
      return get(messageId);
    },

    async claimNextDueOutboxMessage({ workerId, nowMs, leaseMs }) {
      const candidates = Array.from(store.values())
        .filter((message) => ["queued", "retrying", "processing"].includes(message.status))
        .filter((message) => Number(message.nextAttemptAtMs || 0) <= nowMs)
        .sort((a, b) => Number(a.nextAttemptAtMs || 0) - Number(b.nextAttemptAtMs || 0));

      for (const candidate of candidates) {
        const claimed = await this.claimOutboxMessageById({
          messageId: candidate.id,
          workerId,
          nowMs,
          leaseMs,
        });

        if (claimed) {
          return claimed;
        }
      }

      return null;
    },

    async markOutboxMessageSent({ messageId, nowMs }) {
      const record = get(messageId);
      if (!record) {
        return null;
      }

      record.status = "sent";
      record.attemptCount = Number(record.attemptCount || 0) + 1;
      record.leaseOwner = "";
      record.leaseExpiresAtMs = 0;
      record.nextAttemptAtMs = 0;
      record.lastError = null;
      record.sentAtMs = nowMs;
      appendLifecycle(record, {
        toStatus: "sent",
      });
      set(messageId, record);
      return get(messageId);
    },

    async markOutboxMessageFailure({ messageId, nowMs, retryAtMs, maxAttempts, error }) {
      const record = get(messageId);
      if (!record) {
        return null;
      }

      record.attemptCount = Number(record.attemptCount || 0) + 1;
      record.leaseOwner = "";
      record.leaseExpiresAtMs = 0;
      record.lastError = {
        message: String(error && error.message ? error.message : error),
      };

      if (record.attemptCount >= Number(maxAttempts || record.maxAttempts || 5)) {
        record.status = "failed";
        record.failedAtMs = nowMs;
        record.nextAttemptAtMs = 0;
      } else {
        record.status = "retrying";
        record.nextAttemptAtMs = retryAtMs;
      }

      appendLifecycle(record, {
        toStatus: record.status,
      });
      set(messageId, record);
      return get(messageId);
    },

    async getOutboxMessageById(messageId) {
      return get(messageId);
    },

    async listOutboxMessagesByRestaurant({ restaurantId }) {
      return Array.from(store.values())
        .filter((item) => item.restaurantId === restaurantId)
        .map((item) => clone(item));
    },

    async getOutboxStatsByRestaurant(restaurantId) {
      const messages = Array.from(store.values()).filter(
        (item) => item.restaurantId === restaurantId
      );
      const counts = {
        queued: messages.filter((item) => item.status === "queued").length,
        processing: messages.filter((item) => item.status === "processing").length,
        retrying: messages.filter((item) => item.status === "retrying").length,
        sent: messages.filter((item) => item.status === "sent").length,
        failed: messages.filter((item) => item.status === "failed").length,
      };

      return {
        restaurantId,
        counts,
      };
    },

    async retryOutboxMessage({ restaurantId, messageId, nowMs }) {
      const record = get(messageId);
      if (!record || record.restaurantId !== restaurantId) {
        return null;
      }
      if (record.status !== "failed") {
        return record;
      }
      record.status = "queued";
      record.nextAttemptAtMs = nowMs;
      appendLifecycle(record, {
        toStatus: "queued",
        note: "manual_retry_requested",
      });
      set(messageId, record);
      return get(messageId);
    },
  };
}

function buildPayload(overrides = {}) {
  return {
    restaurantId: "rest-1",
    channel: "whatsapp-web",
    recipient: "234000000000@c.us",
    text: "Your order has been confirmed",
    messageType: "order_confirmed",
    sourceAction: "confirmOrder",
    sourceRef: "order-123",
    idempotencyKey: "order:123:confirm",
    metadata: {
      orderId: "order-123",
    },
    ...overrides,
  };
}

test("outbox idempotency prevents duplicate sends for same key", async () => {
  const outboxRepo = createInMemoryOutboxRepo();
  let sendCount = 0;

  const outboxService = createOutboxService({
    outboxRepo,
    channelGateway: {
      sendMessage: async () => {
        sendCount += 1;
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    inlineSendEnabled: true,
    defaultMaxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 1,
    leaseMs: 10_000,
  });

  const first = await outboxService.enqueueAndMaybeDispatch(buildPayload());
  const second = await outboxService.enqueueAndMaybeDispatch(buildPayload());

  assert.equal(sendCount, 1);
  assert.equal(first.message.status, "sent");
  assert.equal(second.duplicate, true);
  assert.equal(second.message.status, "sent");
});

test("outbox retries and eventually reaches failed on retry exhaustion", async () => {
  const outboxRepo = createInMemoryOutboxRepo();
  let sendAttempts = 0;

  const outboxService = createOutboxService({
    outboxRepo,
    channelGateway: {
      sendMessage: async () => {
        sendAttempts += 1;
        throw new Error("transport_down");
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    inlineSendEnabled: false,
    defaultMaxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 1,
    leaseMs: 10_000,
  });

  const enqueueResult = await outboxService.enqueueOutboundMessage(
    buildPayload({
      idempotencyKey: "order:123:confirm:retry",
      maxAttempts: 3,
    })
  );

  const messageId = enqueueResult.message.id;

  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await outboxService.dispatchByMessageId({
      messageId,
      workerId: `worker-${index + 1}`,
    });

    // Wait for retry schedule window so next claim is eligible.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 260));
  }

  const latest = await outboxService.getOutboxMessageById(messageId);

  assert.equal(sendAttempts, 3);
  assert.equal(latest.status, "failed");
  assert.equal(latest.attemptCount, 3);
  assert.ok(latest.lastError && latest.lastError.message.includes("transport_down"));
});
