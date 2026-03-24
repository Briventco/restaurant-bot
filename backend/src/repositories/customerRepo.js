const crypto = require("crypto");
const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function customersCollection(restaurantId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("customers");
}

function customerDocId(channel, channelCustomerId) {
  return crypto
    .createHash("sha1")
    .update(`${channel}:${channelCustomerId}`)
    .digest("hex");
}

async function upsertByChannelIdentity({
  restaurantId,
  channel,
  channelCustomerId,
  customerPhone,
  displayName,
}) {
  const docId = customerDocId(channel, channelCustomerId);
  const ref = customersCollection(restaurantId).doc(docId);
  const snapshot = await ref.get();

  const payload = {
    restaurantId,
    channel,
    channelCustomerId,
    customerPhone,
    displayName: displayName || "",
    updatedAt: FieldValue.serverTimestamp(),
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

module.exports = {
  customerDocId,
  upsertByChannelIdentity,
};
