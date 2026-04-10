const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function jobsCollection() {
  return db.collection("restaurant_activation_jobs");
}

async function createActivationJob(data) {
  const ref = jobsCollection().doc();
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const latest = await ref.get();
  return serializeDoc(latest);
}

async function updateActivationJob(jobId, patch) {
  const ref = jobsCollection().doc(String(jobId || "").trim());
  await ref.set(
    {
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const latest = await ref.get();
  if (!latest.exists) {
    return null;
  }
  return serializeDoc(latest);
}

async function getActivationJobById(jobId) {
  const snapshot = await jobsCollection().doc(String(jobId || "").trim()).get();
  if (!snapshot.exists) {
    return null;
  }
  return serializeDoc(snapshot);
}

async function findActivationJobByRequestId({ restaurantId, requestId }) {
  const safeRestaurantId = String(restaurantId || "").trim();
  const safeRequestId = String(requestId || "").trim();
  if (!safeRestaurantId || !safeRequestId) {
    return null;
  }

  const snapshot = await jobsCollection()
    .where("restaurantId", "==", safeRestaurantId)
    .where("requestId", "==", safeRequestId)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return serializeDoc(snapshot.docs[0]);
}

async function getLatestActivationJobByRestaurantId(restaurantId) {
  const safeRestaurantId = String(restaurantId || "").trim();
  if (!safeRestaurantId) {
    return null;
  }

  const snapshot = await jobsCollection()
    .where("restaurantId", "==", safeRestaurantId)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs
    .map((doc) => serializeDoc(doc))
    .sort((left, right) => {
      const leftTime = new Date(left.createdAt || left.updatedAt || 0).getTime();
      const rightTime = new Date(right.createdAt || right.updatedAt || 0).getTime();
      return rightTime - leftTime;
    })[0] || null;
}

async function listActivationJobsByStatuses({ statuses = [], limit = 25 } = {}) {
  const safeStatuses = Array.isArray(statuses)
    ? statuses.map((status) => String(status || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));

  if (!safeStatuses.length) {
    return [];
  }

  const results = [];
  for (const status of safeStatuses) {
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await jobsCollection()
      .where("status", "==", status)
      .get();

    results.push(...snapshot.docs.map((doc) => serializeDoc(doc)));
  }

  return results
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return leftTime - rightTime;
    })
    .slice(0, safeLimit);
}

module.exports = {
  createActivationJob,
  updateActivationJob,
  getActivationJobById,
  findActivationJobByRequestId,
  getLatestActivationJobByRestaurantId,
  listActivationJobsByStatuses,
};
