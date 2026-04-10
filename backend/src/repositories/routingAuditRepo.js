const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function routingAuditsCollection() {
  return db.collection("metaRoutingAudits");
}

function normalizeAuditPayload(payload = {}) {
  return {
    provider: String(payload.provider || "meta-whatsapp-cloud-api").trim(),
    providerMessageId: String(payload.providerMessageId || "").trim(),
    matchedRestaurantId: String(payload.matchedRestaurantId || "").trim(),
    resolution: String(payload.resolution || "").trim(),
    phoneNumberId: String(payload.phoneNumberId || "").trim(),
    displayPhoneNumber: String(payload.displayPhoneNumber || "").trim(),
    wabaId: String(payload.wabaId || "").trim(),
    channelCustomerId: String(payload.channelCustomerId || "").trim(),
    customerPhone: String(payload.customerPhone || "").trim(),
    messageType: String(payload.messageType || "").trim(),
    textPreview: String(payload.textPreview || "").trim().slice(0, 280),
  };
}

async function createRoutingAudit(payload = {}) {
  const doc = normalizeAuditPayload(payload);

  const ref = await routingAuditsCollection().add({
    ...doc,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snapshot = await ref.get();
  return serializeDoc(snapshot);
}

async function listRecentRoutingAudits(options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
  const restaurantId = String(options.restaurantId || "").trim();

  let query = routingAuditsCollection().orderBy("createdAt", "desc");

  if (restaurantId) {
    query = query.where("matchedRestaurantId", "==", restaurantId);
  }

  const snapshot = await query.limit(Math.max(1, Math.min(200, limit))).get();
  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  createRoutingAudit,
  listRecentRoutingAudits,
};
