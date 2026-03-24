const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function deliveryZonesCollection(restaurantId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("deliveryZones");
}

async function listDeliveryZones(restaurantId) {
  const snapshot = await deliveryZonesCollection(restaurantId)
    .orderBy("name", "asc")
    .get();
  return snapshot.docs.map((doc) => serializeDoc(doc));
}

async function getDeliveryZoneById(restaurantId, zoneId) {
  const snapshot = await deliveryZonesCollection(restaurantId).doc(zoneId).get();
  if (!snapshot.exists) {
    return null;
  }
  return serializeDoc(snapshot);
}

async function createDeliveryZone(restaurantId, payload) {
  const ref = await deliveryZonesCollection(restaurantId).add({
    ...payload,
    restaurantId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const snapshot = await ref.get();
  return serializeDoc(snapshot);
}

async function updateDeliveryZone(restaurantId, zoneId, patch) {
  const ref = deliveryZonesCollection(restaurantId).doc(zoneId);
  await ref.set(
    {
      ...patch,
      restaurantId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    return null;
  }
  return serializeDoc(snapshot);
}

async function deleteDeliveryZone(restaurantId, zoneId) {
  await deliveryZonesCollection(restaurantId).doc(zoneId).delete();
}

module.exports = {
  listDeliveryZones,
  getDeliveryZoneById,
  createDeliveryZone,
  updateDeliveryZone,
  deleteDeliveryZone,
};
