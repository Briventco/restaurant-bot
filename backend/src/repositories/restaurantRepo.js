const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function restaurantRef(restaurantId) {
  return db.collection("restaurants").doc(restaurantId);
}

async function getRestaurantById(restaurantId) {
  const snapshot = await restaurantRef(restaurantId).get();
  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function upsertRestaurant(restaurantId, data) {
  const ref = restaurantRef(restaurantId);
  const snapshot = await ref.get();

  if (snapshot.exists) {
    await ref.set(
      {
        ...data,
        restaurantId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set({
      ...data,
      restaurantId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const latest = await ref.get();
  return serializeDoc(latest);
}

module.exports = {
  getRestaurantById,
  upsertRestaurant,
};
