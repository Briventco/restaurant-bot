const { db, FieldValue } = require("../infra/firebase");

function billingTransactionRef(transactionId) {
  return db.collection("billingTransactions").doc(String(transactionId));
}

async function recordIfNew(transactionId, data = {}) {
  const ref = billingTransactionRef(transactionId);

  try {
    await ref.create({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (error) {
    if (error && (error.code === 6 || String(error.code || "") === "already-exists")) {
      return false;
    }
    throw error;
  }
}

module.exports = {
  recordIfNew,
};
