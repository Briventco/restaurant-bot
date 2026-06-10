const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function conversationMessagesCollection(restaurantId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("conversationMessages");
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
  limit = 200,
}) {
  const effectiveLimit = Math.max(1, Math.min(500, Number(limit) || 200));

  const snapshot = await conversationMessagesCollection(restaurantId)
    .where("channel", "==", String(channel || ""))
    .where("channelCustomerId", "==", String(channelCustomerId || ""))
    .orderBy("createdAtMs", "asc")
    .limit(effectiveLimit)
    .get();

  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  logMessage,
  listMessagesByCustomer,
};
