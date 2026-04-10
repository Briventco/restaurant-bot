const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function currentHealthRef(restaurantId) {
  return db.collection("restaurant_health").doc(String(restaurantId || "").trim());
}

function healthEventCollection() {
  return db.collection("restaurant_health_events");
}

async function getCurrentHealth(restaurantId) {
  const snapshot = await currentHealthRef(restaurantId).get();
  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function upsertCurrentHealth(restaurantId, data) {
  const ref = currentHealthRef(restaurantId);
  await ref.set(
    {
      ...data,
      restaurantId: String(restaurantId || "").trim(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const latest = await ref.get();
  return serializeDoc(latest);
}

async function createHealthEvent(restaurantId, data) {
  const ref = healthEventCollection().doc();
  await ref.set({
    ...data,
    restaurantId: String(restaurantId || "").trim(),
    createdAt: FieldValue.serverTimestamp(),
  });

  const latest = await ref.get();
  return serializeDoc(latest);
}

async function listRecentHealthEvents({ restaurantId = "", limit = 20 } = {}) {
  let query = healthEventCollection().orderBy("createdAt", "desc");
  const safeRestaurantId = String(restaurantId || "").trim();
  if (safeRestaurantId) {
    query = query.where("restaurantId", "==", safeRestaurantId);
  }

  const snapshot = await query.limit(Math.max(1, Math.min(100, Number(limit) || 20))).get();
  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  getCurrentHealth,
  upsertCurrentHealth,
  createHealthEvent,
  listRecentHealthEvents,
};
