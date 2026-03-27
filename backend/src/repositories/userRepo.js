const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function userRef(uid) {
  return db.collection("users").doc(uid);
}

async function getUserByUid(uid) {
  const snapshot = await userRef(uid).get();
  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function upsertUser(uid, data) {
  const ref = userRef(uid);
  const snapshot = await ref.get();

  if (snapshot.exists) {
    await ref.set(
      {
        ...data,
        uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set({
      ...data,
      uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const latest = await ref.get();
  return serializeDoc(latest);
}

module.exports = {
  getUserByUid,
  upsertUser,
};
