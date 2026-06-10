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

async function getCustomerById({ restaurantId, customerId }) {
  const normalizedId = String(customerId || "").trim();
  if (!normalizedId) {
    return null;
  }

  const snapshot = await customersCollection(restaurantId).doc(normalizedId).get();
  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function listCustomers({ restaurantId, limit = 100 }) {
  const effectiveLimit = Math.max(1, Math.min(500, Number(limit) || 100));

  try {
    const snapshot = await customersCollection(restaurantId)
      .orderBy("updatedAt", "desc")
      .limit(effectiveLimit)
      .get();

    return snapshot.docs.map((doc) => serializeDoc(doc));
  } catch (_error) {
    const snapshot = await customersCollection(restaurantId).limit(effectiveLimit).get();
    return snapshot.docs
      .map((doc) => serializeDoc(doc))
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
  }
}

module.exports = {
  customerDocId,
  upsertByChannelIdentity,
  getCustomerById,
  listCustomers,
};
