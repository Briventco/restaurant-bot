const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function conversationMessagesCollection(restaurantId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("conversationMessages");
}

function buildChannelCustomerIdCandidates(channelCustomerId, customerPhone = "") {
  const candidates = new Set();
  const raw = String(channelCustomerId || "").trim();

  if (raw) {
    candidates.add(raw);
    const base = raw.split("@")[0].replace(/\D/g, "");
    if (base) {
      candidates.add(`${base}@c.us`);
      candidates.add(`${base}@lid`);
      candidates.add(base);
    }
  }

  const phone = String(customerPhone || "").trim();
  if (phone) {
    candidates.add(phone);
    const digits = phone.replace(/\D/g, "");
    if (digits) {
      candidates.add(digits);
      candidates.add(`${digits}@c.us`);
      candidates.add(`${digits}@lid`);
    }
  }

  return Array.from(candidates).filter(Boolean);
}

async function logMessage({
  restaurantId,
  channel,
  channelCustomerId,
  direction,
  text,
  messageType = "text",
  providerMessageId = "",
  customerPhone = "",
  displayName = "",
  nowMs = Date.now(),
}) {
  const value = String(text || "").trim();
  if (!value) {
    return null;
  }

  const ref = conversationMessagesCollection(restaurantId).doc();
  const payload = {
    restaurantId,
    channel: String(channel || ""),
    channelCustomerId: String(channelCustomerId || ""),
    direction: direction === "in" ? "in" : "out",
    text: value,
    messageType: String(messageType || "text"),
    providerMessageId: String(providerMessageId || ""),
    customerPhone: String(customerPhone || ""),
    displayName: String(displayName || ""),
    createdAtMs: nowMs,
    createdAt: FieldValue.serverTimestamp(),
  };

  await ref.set(payload);
  return { id: ref.id, ...payload };
}

async function listMessagesByCustomer({
  restaurantId,
  channel,
  channelCustomerId,
  customerPhone = "",
  limit = 200,
  beforeMs = 0,
}) {
  const effectiveLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const normalizedChannel = String(channel || "").trim();
  const effectiveBeforeMs = Number(beforeMs) > 0 ? Number(beforeMs) : 0;
  const candidates = buildChannelCustomerIdCandidates(channelCustomerId, customerPhone);

  if (!candidates.length) {
    return [];
  }

  const byId = new Map();

  for (const candidate of candidates) {
    let query = conversationMessagesCollection(restaurantId).where("channelCustomerId", "==", candidate);
    if (effectiveBeforeMs > 0) {
      query = query.where("createdAtMs", "<", effectiveBeforeMs).orderBy("createdAtMs", "desc");
    } else {
      query = query.orderBy("createdAtMs", "desc");
    }

    const snapshot = await query.limit(effectiveLimit).get();

    for (const doc of snapshot.docs) {
      const message = serializeDoc(doc);
      if (normalizedChannel && String(message.channel || "").trim() !== normalizedChannel) {
        continue;
      }
      byId.set(message.id, message);
    }
  }

  return Array.from(byId.values()).sort(
    (left, right) => Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0)
  );
}

module.exports = {
  buildChannelCustomerIdCandidates,
  logMessage,
  listMessagesByCustomer,
};
