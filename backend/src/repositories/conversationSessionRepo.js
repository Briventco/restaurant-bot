const crypto = require("crypto");
const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function conversationSessionsCollection(restaurantId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("conversationSessions");
}

function conversationSessionDocId(channel, channelCustomerId) {
  return crypto
    .createHash("sha1")
    .update(`${String(channel || "")}:${String(channelCustomerId || "")}`)
    .digest("hex");
}

async function getSession(restaurantId, channel, channelCustomerId) {
  const snapshot = await conversationSessionsCollection(restaurantId)
    .doc(conversationSessionDocId(channel, channelCustomerId))
    .get();

  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function upsertSession(restaurantId, channel, channelCustomerId, patch) {
  const ref = conversationSessionsCollection(restaurantId).doc(
    conversationSessionDocId(channel, channelCustomerId)
  );
  const snapshot = await ref.get();

  const payload = {
    restaurantId,
    channel,
    channelCustomerId,
    updatedAt: FieldValue.serverTimestamp(),
    ...(patch || {}),
  };

  if (snapshot.exists) {
    await ref.set(payload, { merge: true });
  } else {
    await ref.set({
      ...payload,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  const latest = await ref.get();
  return serializeDoc(latest);
}

async function clearSession(restaurantId, channel, channelCustomerId) {
  await conversationSessionsCollection(restaurantId)
    .doc(conversationSessionDocId(channel, channelCustomerId))
    .delete();
}

module.exports = {
  getSession,
  upsertSession,
  clearSession,
  conversationSessionDocId,
};
