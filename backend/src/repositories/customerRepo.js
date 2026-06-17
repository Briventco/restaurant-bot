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

function normalizePhoneLike(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function buildPhoneCandidates(value) {
  const raw = String(value || "").trim();
  const digits = normalizePhoneLike(raw);
  const variants = new Set();

  if (raw) {
    variants.add(raw);
  }
  if (digits) {
    variants.add(digits);
  }

  if (digits.startsWith("0") && digits.length === 11) {
    variants.add(`234${digits.slice(1)}`);
  }
  if (digits.startsWith("234") && digits.length >= 12) {
    variants.add(`0${digits.slice(3)}`);
  }

  const numericForms = Array.from(variants).filter((item) => /^\d+$/.test(item));
  for (const form of numericForms) {
    variants.add(`${form}@c.us`);
    variants.add(`${form}@lid`);
  }

  return Array.from(variants).filter(Boolean);
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

  if (snapshot.exists) {
    const current = snapshot.data() || {};
    const payload = {
      restaurantId,
      channel,
      channelCustomerId,
      customerPhone: normalizedPhone || String(current.customerPhone || "").trim(),
      displayName: normalizedDisplayName || String(current.displayName || "").trim(),
      updatedAt: FieldValue.serverTimestamp(),
      lastMessageAt: FieldValue.serverTimestamp(),
    };

    await ref.set(payload, { merge: true });
    const updated = await ref.get();
    return serializeDoc(updated);
  }

  const payload = {
    restaurantId,
    channel,
    channelCustomerId,
    customerPhone: normalizedPhone,
    displayName: normalizedDisplayName,
    updatedAt: FieldValue.serverTimestamp(),
    lastMessageAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };

  await ref.set(payload);
  const created = await ref.get();
  return serializeDoc(created);
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

async function findCustomerByPhone({ restaurantId, customerPhone }) {
  const candidates = buildPhoneCandidates(customerPhone);
  if (!candidates.length) {
    return null;
  }

  for (const candidate of candidates) {
    const snapshot = await customersCollection(restaurantId)
      .where("customerPhone", "==", candidate)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      return serializeDoc(snapshot.docs[0]);
    }
  }

  return null;
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
  findCustomerByPhone,
  listCustomers,
};
