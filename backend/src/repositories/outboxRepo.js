const { db } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

const OUTBOX_COLLECTION = "outboundOutbox";
const TERMINAL_STATUSES = new Set(["sent", "failed"]);
const CLAIMABLE_STATUSES = ["queued", "retrying", "processing"];
const MAX_LIFECYCLE_EVENTS = 30;

function outboxCollection() {
  return db.collection(OUTBOX_COLLECTION);
}

function outboxRef(messageId) {
  return outboxCollection().doc(String(messageId || "").trim());
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeError(error) {
  if (!error) {
    return {
      message: "Unknown error",
      code: "",
      stack: "",
    };
  }

  return {
    message: String(error.message || error || "Unknown error"),
    code: String(error.code || ""),
    stack: String(error.stack || "").slice(0, 4000),
  };
}

function appendLifecycle(data, event) {
  const existing = Array.isArray(data.lifecycle) ? data.lifecycle : [];
  const next = existing.concat(event);
  if (next.length <= MAX_LIFECYCLE_EVENTS) {
    return next;
  }
  return next.slice(next.length - MAX_LIFECYCLE_EVENTS);
}

function buildLifecycleEvent({
  nowMs,
  fromStatus,
  toStatus,
  actor,
  attempt,
  note,
  error,
}) {
  return {
    atMs: nowMs,
    fromStatus: fromStatus || null,
    toStatus: toStatus || null,
    actor: String(actor || "system"),
    attempt: toSafeNumber(attempt, 0),
    note: String(note || ""),
    error: error || null,
  };
}

function hydrateDoc(snapshot) {
  if (!snapshot || !snapshot.exists) {
    return null;
  }
  return serializeDoc(snapshot);
}

async function getOutboxMessageById(messageId) {
  const snapshot = await outboxRef(messageId).get();
  return hydrateDoc(snapshot);
}

async function createOutboxMessageIfAbsent(payload) {
  const messageId = String(payload.messageId || "").trim();
  if (!messageId) {
    throw new Error("messageId is required");
  }

  const nowMs = toSafeNumber(payload.nowMs, Date.now());
  const maxAttempts = Math.max(1, toSafeNumber(payload.maxAttempts, 5));
  const ref = outboxRef(messageId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);

    if (snapshot.exists) {
      const existing = hydrateDoc(snapshot);
      if (existing.payloadHash !== payload.payloadHash) {
        const conflict = new Error("Idempotency key conflict: payload hash mismatch");
        conflict.statusCode = 409;
        throw conflict;
      }

      return {
        message: existing,
        created: false,
        duplicate: true,
      };
    }

    const lifecycle = [
      buildLifecycleEvent({
        nowMs,
        fromStatus: null,
        toStatus: "queued",
        actor: "api",
        attempt: 0,
        note: "outbox_created",
      }),
    ];

    const doc = {
      messageId,
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
      maxAttempts,
      nextAttemptAtMs: nowMs,
      leaseOwner: "",
      leaseExpiresAtMs: 0,
      lastAttemptAtMs: 0,
      lastError: null,
      providerMessageId: "",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      sentAtMs: 0,
      failedAtMs: 0,
      lifecycle,
    };

    tx.set(ref, doc);

    return {
      message: {
        id: messageId,
        ...doc,
      },
      created: true,
      duplicate: false,
    };
  });
}

async function claimOutboxMessageById({
  messageId,
  workerId,
  nowMs = Date.now(),
  leaseMs = 30_000,
}) {
  const ref = outboxRef(messageId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data() || {};
    const status = String(data.status || "");

    if (TERMINAL_STATUSES.has(status)) {
      return null;
    }

    const nextAttemptAtMs = toSafeNumber(data.nextAttemptAtMs, 0);
    if (nextAttemptAtMs > nowMs) {
      return null;
    }

    const currentLeaseOwner = String(data.leaseOwner || "");
    const leaseExpiresAtMs = toSafeNumber(data.leaseExpiresAtMs, 0);
    const activeLease =
      status === "processing" &&
      currentLeaseOwner &&
      currentLeaseOwner !== workerId &&
      leaseExpiresAtMs > nowMs;

    if (activeLease) {
      return null;
    }

    const lifecycle = appendLifecycle(
      data,
      buildLifecycleEvent({
        nowMs,
        fromStatus: status || null,
        toStatus: "processing",
        actor: workerId,
        attempt: toSafeNumber(data.attemptCount, 0),
        note: "lease_claimed",
      })
    );

    const patch = {
      status: "processing",
      leaseOwner: workerId,
      leaseExpiresAtMs: nowMs + Math.max(1_000, toSafeNumber(leaseMs, 30_000)),
      updatedAtMs: nowMs,
      lifecycle,
    };

    tx.set(ref, patch, { merge: true });

    return {
      id: snapshot.id,
      ...data,
      ...patch,
    };
  });
}

async function claimNextDueOutboxMessage({
  workerId,
  nowMs = Date.now(),
  leaseMs = 30_000,
  limitCandidates = 10,
}) {
  const sampleSize = Math.max(5, Math.min(200, toSafeNumber(limitCandidates, 10) * 5));
  const snapshot = await outboxCollection()
    .where("nextAttemptAtMs", "<=", nowMs)
    .limit(sampleSize)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const orderedCandidates = snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((doc) => CLAIMABLE_STATUSES.includes(String(doc.status || "")))
    .sort((left, right) => toSafeNumber(left.nextAttemptAtMs, 0) - toSafeNumber(right.nextAttemptAtMs, 0))
    .slice(0, Math.max(1, Math.min(50, toSafeNumber(limitCandidates, 10))));

  for (const doc of orderedCandidates) {
    const claimed = await claimOutboxMessageById({
      messageId: doc.id || doc.messageId,
      workerId,
      nowMs,
      leaseMs,
    });

    if (claimed) {
      return claimed;
    }
  }

  return null;
}

async function markOutboxMessageSent({
  messageId,
  workerId,
  nowMs = Date.now(),
  providerMessageId = "",
  providerResponse = {},
}) {
  const ref = outboxRef(messageId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data() || {};
    const status = String(data.status || "");

    if (status === "sent") {
      return {
        id: snapshot.id,
        ...data,
      };
    }

    const leaseOwner = String(data.leaseOwner || "");
    const leaseExpiresAtMs = toSafeNumber(data.leaseExpiresAtMs, 0);
    const activeLeaseOwnedByOther =
      status === "processing" &&
      leaseOwner &&
      leaseOwner !== workerId &&
      leaseExpiresAtMs > nowMs;

    if (activeLeaseOwnedByOther) {
      return null;
    }

    const attemptCount = toSafeNumber(data.attemptCount, 0) + 1;
    const lifecycle = appendLifecycle(
      data,
      buildLifecycleEvent({
        nowMs,
        fromStatus: status || null,
        toStatus: "sent",
        actor: workerId,
        attempt: attemptCount,
        note: "delivery_success",
      })
    );

    const patch = {
      status: "sent",
      attemptCount,
      lastAttemptAtMs: nowMs,
      sentAtMs: nowMs,
      failedAtMs: 0,
      updatedAtMs: nowMs,
      providerMessageId: String(providerMessageId || ""),
      providerResponse: providerResponse || {},
      lastError: null,
      leaseOwner: "",
      leaseExpiresAtMs: 0,
      nextAttemptAtMs: 0,
      lifecycle,
    };

    tx.set(ref, patch, { merge: true });

    return {
      id: snapshot.id,
      ...data,
      ...patch,
    };
  });
}

async function markOutboxMessageFailure({
  messageId,
  workerId,
  nowMs = Date.now(),
  retryAtMs,
  maxAttempts,
  error,
}) {
  const ref = outboxRef(messageId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data() || {};
    const status = String(data.status || "");

    if (TERMINAL_STATUSES.has(status)) {
      return {
        id: snapshot.id,
        ...data,
      };
    }

    const leaseOwner = String(data.leaseOwner || "");
    const leaseExpiresAtMs = toSafeNumber(data.leaseExpiresAtMs, 0);
    const activeLeaseOwnedByOther =
      status === "processing" &&
      leaseOwner &&
      leaseOwner !== workerId &&
      leaseExpiresAtMs > nowMs;

    if (activeLeaseOwnedByOther) {
      return null;
    }

    const attemptCount = toSafeNumber(data.attemptCount, 0) + 1;
    const effectiveMaxAttempts = Math.max(
      1,
      toSafeNumber(maxAttempts, toSafeNumber(data.maxAttempts, 5))
    );
    const exhausted = attemptCount >= effectiveMaxAttempts;
    const nextStatus = exhausted ? "failed" : "retrying";
    const safeError = sanitizeError(error);

    const lifecycle = appendLifecycle(
      data,
      buildLifecycleEvent({
        nowMs,
        fromStatus: status || null,
        toStatus: nextStatus,
        actor: workerId,
        attempt: attemptCount,
        note: exhausted ? "retry_exhausted" : "delivery_retry_scheduled",
        error: {
          message: safeError.message,
          code: safeError.code,
        },
      })
    );

    const patch = {
      status: nextStatus,
      attemptCount,
      maxAttempts: effectiveMaxAttempts,
      lastAttemptAtMs: nowMs,
      updatedAtMs: nowMs,
      lastError: safeError,
      leaseOwner: "",
      leaseExpiresAtMs: 0,
      nextAttemptAtMs: exhausted ? 0 : Math.max(nowMs + 1000, toSafeNumber(retryAtMs, nowMs + 1000)),
      failedAtMs: exhausted ? nowMs : 0,
      lifecycle,
    };

    tx.set(ref, patch, { merge: true });

    return {
      id: snapshot.id,
      ...data,
      ...patch,
    };
  });
}

async function listOutboxMessagesByRestaurant({
  restaurantId,
  status,
  limit = 50,
}) {
  const effectiveLimit = Math.max(1, Math.min(200, toSafeNumber(limit, 50)));
  const effectiveStatus = String(status || "").trim();

  try {
    let query = outboxCollection()
      .where("restaurantId", "==", restaurantId)
      .orderBy("createdAtMs", "desc")
      .limit(effectiveLimit);

    if (effectiveStatus) {
      query = outboxCollection()
        .where("restaurantId", "==", restaurantId)
        .where("status", "==", effectiveStatus)
        .orderBy("createdAtMs", "desc")
        .limit(effectiveLimit);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => serializeDoc(doc));
  } catch (_error) {
    let query = outboxCollection().where("restaurantId", "==", restaurantId);
    if (effectiveStatus) {
      query = query.where("status", "==", effectiveStatus);
    }

    const snapshot = await query.get();
    return snapshot.docs
      .map((doc) => serializeDoc(doc))
      .sort((left, right) => toSafeNumber(right.createdAtMs, 0) - toSafeNumber(left.createdAtMs, 0))
      .slice(0, effectiveLimit);
  }
}

async function getOutboxStatsByRestaurant(restaurantId) {
  const statuses = ["queued", "processing", "retrying", "sent", "failed"];
  const counts = {};

  for (const status of statuses) {
    try {
      const aggregate = await outboxCollection()
        .where("restaurantId", "==", restaurantId)
        .where("status", "==", status)
        .count()
        .get();

      counts[status] = toSafeNumber(aggregate.data().count, 0);
    } catch (_error) {
      const snapshot = await outboxCollection()
        .where("restaurantId", "==", restaurantId)
        .where("status", "==", status)
        .limit(5000)
        .get();
      counts[status] = snapshot.size;
    }
  }

  let oldestPending = null;
  try {
    const oldestPendingSnapshot = await outboxCollection()
      .where("restaurantId", "==", restaurantId)
      .where("status", "in", ["queued", "retrying", "processing"])
      .orderBy("nextAttemptAtMs", "asc")
      .limit(1)
      .get();

    oldestPending = oldestPendingSnapshot.empty
      ? null
      : serializeDoc(oldestPendingSnapshot.docs[0]);
  } catch (_error) {
    const fallbackSnapshot = await outboxCollection()
      .where("restaurantId", "==", restaurantId)
      .get();

    const pending = fallbackSnapshot.docs
      .map((doc) => serializeDoc(doc))
      .filter((doc) => ["queued", "retrying", "processing"].includes(String(doc.status || "")))
      .sort((left, right) => toSafeNumber(left.nextAttemptAtMs, 0) - toSafeNumber(right.nextAttemptAtMs, 0));

    oldestPending = pending.length ? pending[0] : null;
  }

  return {
    restaurantId,
    counts,
    pendingTotal:
      toSafeNumber(counts.queued) +
      toSafeNumber(counts.retrying) +
      toSafeNumber(counts.processing),
    oldestPendingMessageId: oldestPending ? oldestPending.id : "",
    oldestPendingNextAttemptAtMs: oldestPending ? oldestPending.nextAttemptAtMs || 0 : 0,
  };
}

async function retryOutboxMessage({
  restaurantId,
  messageId,
  requestedBy,
  nowMs = Date.now(),
}) {
  const ref = outboxRef(messageId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data() || {};
    if (data.restaurantId !== restaurantId) {
      return null;
    }

    const status = String(data.status || "");
    if (status === "sent") {
      return {
        id: snapshot.id,
        ...data,
      };
    }

    const lifecycle = appendLifecycle(
      data,
      buildLifecycleEvent({
        nowMs,
        fromStatus: status || null,
        toStatus: "queued",
        actor: String(requestedBy || "ops"),
        attempt: toSafeNumber(data.attemptCount, 0),
        note: "manual_retry_requested",
      })
    );

    const patch = {
      status: "queued",
      nextAttemptAtMs: nowMs,
      updatedAtMs: nowMs,
      leaseOwner: "",
      leaseExpiresAtMs: 0,
      failedAtMs: 0,
      lifecycle,
    };

    tx.set(ref, patch, { merge: true });

    return {
      id: snapshot.id,
      ...data,
      ...patch,
    };
  });
}

module.exports = {
  getOutboxMessageById,
  createOutboxMessageIfAbsent,
  claimOutboxMessageById,
  claimNextDueOutboxMessage,
  markOutboxMessageSent,
  markOutboxMessageFailure,
  listOutboxMessagesByRestaurant,
  getOutboxStatsByRestaurant,
  retryOutboxMessage,
  sanitizeError,
};
