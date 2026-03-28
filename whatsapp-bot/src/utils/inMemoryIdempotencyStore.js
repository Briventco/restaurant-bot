function createInMemoryIdempotencyStore({
  inFlightTtlMs,
  sentTtlMs,
  failedTtlMs,
  maxEntries = 20000,
}) {
  const records = new Map();

  function toSafeNow(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function cleanup(now = Date.now()) {
    for (const [key, record] of records.entries()) {
      if (!record || Number(record.expiresAtMs || 0) <= now) {
        records.delete(key);
      }
    }

    if (records.size <= maxEntries) {
      return;
    }

    const overflow = records.size - maxEntries;
    const keys = Array.from(records.keys());
    for (let index = 0; index < overflow; index += 1) {
      records.delete(keys[index]);
    }
  }

  function begin(key, nowMs = Date.now()) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      return {
        ok: false,
        reason: "missing_key",
      };
    }

    const now = toSafeNow(nowMs);
    cleanup(now);

    const existing = records.get(normalizedKey);
    if (existing) {
      if (existing.status === "sent") {
        return {
          ok: false,
          reason: "already_sent",
          record: existing,
        };
      }

      if (existing.status === "processing") {
        return {
          ok: false,
          reason: "in_flight",
          record: existing,
        };
      }
    }

    const next = {
      status: "processing",
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + Math.max(1000, Number(inFlightTtlMs || 30000)),
      attemptCount: 0,
      result: null,
      error: null,
    };
    records.set(normalizedKey, next);

    return {
      ok: true,
      reason: "started",
      record: next,
    };
  }

  function markSent(key, payload = {}, nowMs = Date.now()) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      return null;
    }

    const now = toSafeNow(nowMs);
    const existing = records.get(normalizedKey) || {};
    const next = {
      ...existing,
      status: "sent",
      updatedAtMs: now,
      expiresAtMs: now + Math.max(60 * 1000, Number(sentTtlMs || 24 * 60 * 60 * 1000)),
      result: payload,
      error: null,
      attemptCount: Number(existing.attemptCount || 0) + 1,
    };
    records.set(normalizedKey, next);
    cleanup(now);
    return next;
  }

  function markFailed(key, payload = {}, nowMs = Date.now()) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      return null;
    }

    const now = toSafeNow(nowMs);
    const existing = records.get(normalizedKey) || {};
    const next = {
      ...existing,
      status: "failed",
      updatedAtMs: now,
      expiresAtMs: now + Math.max(30 * 1000, Number(failedTtlMs || 30 * 60 * 1000)),
      error: payload,
      result: null,
      attemptCount: Number(existing.attemptCount || 0) + 1,
    };
    records.set(normalizedKey, next);
    cleanup(now);
    return next;
  }

  function get(key, nowMs = Date.now()) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      return null;
    }

    const now = toSafeNow(nowMs);
    cleanup(now);
    return records.get(normalizedKey) || null;
  }

  return {
    begin,
    markSent,
    markFailed,
    get,
    cleanup,
    size: () => records.size,
  };
}

module.exports = {
  createInMemoryIdempotencyStore,
};
