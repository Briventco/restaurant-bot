const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function ordersCollection(restaurantId) {
  return db.collection("restaurants").doc(restaurantId).collection("orders");
}

function orderRef(restaurantId, orderId) {
  return ordersCollection(restaurantId).doc(orderId);
}

function statusHistoryCollection(restaurantId, orderId) {
  return orderRef(restaurantId, orderId).collection("statusHistory");
}

function messagesCollection(restaurantId, orderId) {
  return orderRef(restaurantId, orderId).collection("messages");
}

async function listOrders(restaurantId, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
  let query = ordersCollection(restaurantId).orderBy("createdAt", "desc").limit(limit);

  if (options.status) {
    query = query.where("status", "==", options.status);
  }

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => serializeDoc(doc));
}

async function listOrdersByStatuses(restaurantId, statuses, options = {}) {
  const safeStatuses = Array.isArray(statuses)
    ? statuses.map((status) => String(status || "").trim()).filter(Boolean)
    : [];

  if (!safeStatuses.length) {
    return [];
  }

  const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
  const snapshot = await ordersCollection(restaurantId)
    .where("status", "in", safeStatuses.slice(0, 10))
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => serializeDoc(doc));
}

async function getOrderById(restaurantId, orderId) {
  const snapshot = await orderRef(restaurantId, orderId).get();
  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function createOrder(restaurantId, payload) {
  const ref = await ordersCollection(restaurantId).add({
    ...payload,
    restaurantId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snapshot = await ref.get();
  return serializeDoc(snapshot);
}

async function updateOrder(restaurantId, orderId, patch) {
  const ref = orderRef(restaurantId, orderId);
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

async function addStatusHistory(restaurantId, orderId, payload) {
  const ref = await statusHistoryCollection(restaurantId, orderId).add({
    ...payload,
    restaurantId,
    orderId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snapshot = await ref.get();
  return serializeDoc(snapshot);
}

async function transitionStatusWithHistory({
  restaurantId,
  orderId,
  toStatus,
  fromStatus,
  actor,
  reason,
  metadata,
  patch,
}) {
  const ref = orderRef(restaurantId, orderId);
  const historyRef = statusHistoryCollection(restaurantId, orderId).doc();
  const batch = db.batch();

  batch.set(
    ref,
    {
      restaurantId,
      status: toStatus,
      ...(patch || {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  batch.set(historyRef, {
    restaurantId,
    orderId,
    fromStatus: fromStatus || null,
    toStatus,
    actorType: (actor && actor.type) || "system",
    actorId: (actor && actor.id) || null,
    reason: reason || "",
    metadata: metadata || {},
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();

  const latest = await ref.get();
  return latest.exists ? serializeDoc(latest) : null;
}

async function findActiveOrderByCustomer({
  restaurantId,
  channel,
  channelCustomerId,
  activeStatuses,
}) {
  const snapshot = await ordersCollection(restaurantId)
    .where("channel", "==", channel)
    .where("channelCustomerId", "==", channelCustomerId)
    .where("status", "in", activeStatuses)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return serializeDoc(snapshot.docs[0]);
}

async function addOrderMessage(restaurantId, orderId, payload) {
  const ref = await messagesCollection(restaurantId, orderId).add({
    ...payload,
    restaurantId,
    orderId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snapshot = await ref.get();
  return serializeDoc(snapshot);
}

async function listOrderMessages(restaurantId, orderId, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
  const snapshot = await messagesCollection(restaurantId, orderId)
    .orderBy("createdAt", "desc")
    .limit(Math.max(1, Math.min(200, limit)))
    .get();

  return snapshot.docs.map((doc) => serializeDoc(doc));
}

module.exports = {
  listOrders,
  listOrdersByStatuses,
  getOrderById,
  createOrder,
  updateOrder,
  addStatusHistory,
  transitionStatusWithHistory,
  findActiveOrderByCustomer,
  addOrderMessage,
  listOrderMessages,
};
