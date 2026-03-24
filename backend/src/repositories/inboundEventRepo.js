const crypto = require("crypto");
const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function inboundEventsCollection(restaurantId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("inboundEvents");
}

function eventDocId(providerMessageId) {
  return crypto.createHash("sha1").update(providerMessageId).digest("hex");
}

async function markInboundEventIfNew({
  restaurantId,
  providerMessageId,
  channel,
  channelCustomerId,
  customerPhone,
}) {
  const docId = eventDocId(providerMessageId || `${Date.now()}`);
  const ref = inboundEventsCollection(restaurantId).doc(docId);

  const result = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) {
      return false;
    }

    tx.set(ref, {
      restaurantId,
      providerMessageId,
      channel,
      channelCustomerId,
      customerPhone,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return true;
  });

  return result;
}

module.exports = {
  markInboundEventIfNew,
  async listRecentInboundEvents(restaurantId, options = {}) {
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 20;
    const snapshot = await inboundEventsCollection(restaurantId)
      .orderBy("createdAt", "desc")
      .limit(Math.max(1, Math.min(100, limit)))
      .get();

    return snapshot.docs.map((doc) => serializeDoc(doc));
  },
};
