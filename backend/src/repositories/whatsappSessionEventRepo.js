const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function eventCollection() {
  return db.collection("whatsapp_session_events");
}

async function createSessionEvent(restaurantId, data) {
  const ref = eventCollection().doc();
  await ref.set({
    ...data,
    restaurantId: String(restaurantId || "").trim(),
    createdAt: FieldValue.serverTimestamp(),
  });

  const latest = await ref.get();
  return serializeDoc(latest);
}

async function listRecentSessionEvents({ restaurantId = "", limit = 20 } = {}) {
  let query = eventCollection().orderBy("createdAt", "desc");
  const safeRestaurantId = String(restaurantId || "").trim();

  if (safeRestaurantId) {
    query = query.where("restaurantId", "==", safeRestaurantId);
  }

  const snapshot = await query.limit(Math.max(1, Math.min(100, Number(limit) || 20))).get();
  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  createSessionEvent,
  listRecentSessionEvents,
};
