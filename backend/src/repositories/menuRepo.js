const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function menuCollection(restaurantId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("menuItems");
}

async function listMenuItems(restaurantId) {
  const snapshot = await menuCollection(restaurantId).orderBy("name", "asc").get();
  return snapshot.docs.map((doc) => serializeDoc(doc));
}

async function getMenuItemById(restaurantId, itemId) {
  const snapshot = await menuCollection(restaurantId).doc(itemId).get();
  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function createMenuItem(restaurantId, payload) {
  const docRef = await menuCollection(restaurantId).add({
    ...payload,
    restaurantId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snapshot = await docRef.get();
  return serializeDoc(snapshot);
}

async function updateMenuItem(restaurantId, itemId, patch) {
  const ref = menuCollection(restaurantId).doc(itemId);
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

async function deleteMenuItem(restaurantId, itemId) {
  await menuCollection(restaurantId).doc(itemId).delete();
}

module.exports = {
  listMenuItems,
  getMenuItemById,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
};
