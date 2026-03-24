const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function apiKeyRef(restaurantId, keyId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("apiKeys")
    .doc(keyId);
}

async function getApiKeyById(restaurantId, keyId) {
  const snapshot = await apiKeyRef(restaurantId, keyId).get();
  if (!snapshot.exists) {
    return null;
  }

  const record = serializeDoc(snapshot);
  return {
    ...record,
    keyId,
    restaurantId,
  };
}

async function upsertApiKey(restaurantId, keyId, payload) {
  const ref = apiKeyRef(restaurantId, keyId);
  const snapshot = await ref.get();

  if (snapshot.exists) {
    await ref.set(
      {
        ...payload,
        keyId,
        restaurantId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set({
      ...payload,
      keyId,
      restaurantId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const latest = await ref.get();
  return serializeDoc(latest);
}

module.exports = {
  getApiKeyById,
  upsertApiKey,
};
