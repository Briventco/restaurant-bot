const { FieldValue, db } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function paymentReceiptsCollection(restaurantId, orderId) {
  return db
    .collection("restaurants")
    .doc(restaurantId)
    .collection("orders")
    .doc(orderId)
    .collection("paymentReceipts");
}

async function createPaymentReceipt(restaurantId, orderId, payload) {
  const ref = await paymentReceiptsCollection(restaurantId, orderId).add({
    ...payload,
    restaurantId,
    orderId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snapshot = await ref.get();
  return serializeDoc(snapshot);
}

async function getPaymentReceiptById(restaurantId, orderId, receiptId) {
  const snapshot = await paymentReceiptsCollection(restaurantId, orderId)
    .doc(receiptId)
    .get();
  if (!snapshot.exists) {
    return null;
  }
  return serializeDoc(snapshot);
}

async function updatePaymentReceipt(restaurantId, orderId, receiptId, patch) {
  const ref = paymentReceiptsCollection(restaurantId, orderId).doc(receiptId);
  await ref.set(
    {
      ...patch,
      restaurantId,
      orderId,
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

async function listPaymentReceipts(restaurantId, orderId) {
  const snapshot = await paymentReceiptsCollection(restaurantId, orderId)
    .orderBy("createdAt", "desc")
    .get();

  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  createPaymentReceipt,
  getPaymentReceiptById,
  updatePaymentReceipt,
  listPaymentReceipts,
};
