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
  const safeRestaurantId = String(restaurantId || "").trim();
  const effectiveLimit = Math.max(1, Math.min(100, Number(limit) || 20));

  if (safeRestaurantId) {
    const snapshot = await eventCollection()
      .where("restaurantId", "==", safeRestaurantId)
      .limit(effectiveLimit)
      .get();

    return snapshot.docs
      .map((doc) => serializeDoc(doc))
      .sort((left, right) => {
        const rightTime = new Date(right.createdAt || 0).getTime();
        const leftTime = new Date(left.createdAt || 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, effectiveLimit);
  }

  const snapshot = await eventCollection()
    .orderBy("createdAt", "desc")
    .limit(effectiveLimit)
    .get();

  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  createSessionEvent,
  listRecentSessionEvents,
};
