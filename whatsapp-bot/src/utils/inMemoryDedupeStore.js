function createInMemoryDedupeStore({ ttlMs, maxEntries }) {
  const seen = new Map();

  function cleanup(now = Date.now()) {
    for (const [key, expiresAt] of seen.entries()) {
      if (expiresAt <= now) {
        seen.delete(key);
      }
    }

    if (seen.size > maxEntries) {
      const overflow = seen.size - maxEntries;
      const keys = Array.from(seen.keys());
      for (let index = 0; index < overflow; index += 1) {
        seen.delete(keys[index]);
      }
    }
  }

  function isDuplicate(messageId) {
    if (!messageId) {
      return false;
    }

    const now = Date.now();
    cleanup(now);

    const existing = seen.get(messageId);
    if (existing && existing > now) {
      return true;
    }

    seen.set(messageId, now + ttlMs);
    return false;
  }

  return {
    isDuplicate,
    size: () => seen.size,
    cleanup,
  };
}

module.exports = {
  createInMemoryDedupeStore,
};
