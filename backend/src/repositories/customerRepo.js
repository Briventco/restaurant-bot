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
  const normalizedDisplayName = String(displayName || "").trim();
  const normalizedPhone = String(customerPhone || "").trim();

  const payload = {
    restaurantId,
    channel,
    channelCustomerId,
    customerPhone: normalizedPhone,
    displayName: normalizedDisplayName,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (snapshot.exists) {
    const current = snapshot.data() || {};
    const currentDisplayName = String(current.displayName || "").trim();
    const currentPhone = String(current.customerPhone || "").trim();
    const needsUpdate =
      currentDisplayName !== normalizedDisplayName ||
      currentPhone !== normalizedPhone;

    if (!needsUpdate) {
      return serializeDoc(snapshot);
    }

    await ref.set(payload, { merge: true });
    return {
      id: snapshot.id,
      ...current,
      ...payload,
      updatedAt: new Date().toISOString(),
    };
  } else {
    await ref.set({
      ...payload,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      id: docId,
      ...payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

async function listCustomers({ restaurantId, limit = 100 }) {
  const effectiveLimit = Math.max(1, Math.min(500, Number(limit) || 100));

  const snapshot = await customersCollection(restaurantId)
    .orderBy("updatedAt", "desc")
    .limit(effectiveLimit)
    .get();

  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  customerDocId,
  upsertByChannelIdentity,
  listCustomers,
};
