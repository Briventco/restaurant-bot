const { db } = require('../infra/firebase');

const COLLECTION_NAME = 'restaurantSubscriptions';

async function createSubscription(subscriptionData) {
  const docRef = db.collection(COLLECTION_NAME).doc();
  const now = new Date().toISOString();
  
  // Calculate end date based on billing cycle
  const startDate = new Date(subscriptionData.startDate || now);
  let endDate = null;
  
  if (subscriptionData.billingCycle === 'monthly') {
    endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + 1);
  } else if (subscriptionData.billingCycle === 'yearly') {
    endDate = new Date(startDate);
    endDate.setFullYear(endDate.getFullYear() + 1);
  }
  
  const subscription = {
    id: docRef.id,
    restaurantId: subscriptionData.restaurantId,
    planId: subscriptionData.planId,
    planName: subscriptionData.planName,
    status: subscriptionData.status || 'active',
    startDate: startDate.toISOString(),
    endDate: endDate ? endDate.toISOString() : null,
    billingCycle: subscriptionData.billingCycle || 'monthly',
    autoRenew: subscriptionData.autoRenew !== false,
    amount: Number(subscriptionData.amount),
    currency: subscriptionData.currency || 'NGN',
    createdAt: now,
    updatedAt: now,
  };

  await docRef.set(subscription);
  return subscription;
}

async function getSubscriptionByRestaurantId(restaurantId) {
  const snapshot = await db
    .collection(COLLECTION_NAME)
    .where('restaurantId', '==', restaurantId)
    .where('status', '==', 'active')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function listSubscriptions(options = {}) {
  const { status, limit = 50 } = options;
  let query = db.collection(COLLECTION_NAME);

  if (status) {
    query = query.where('status', '==', status);
  }

  const snapshot = await query.orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function updateSubscription(subscriptionId, updates) {
  const docRef = db.collection(COLLECTION_NAME).doc(subscriptionId);
  const doc = await docRef.get();
  
  if (!doc.exists) {
    throw new Error('Subscription not found');
  }

  const updateData = {
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await docRef.update(updateData);
  const updatedDoc = await docRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
}

async function cancelSubscription(subscriptionId) {
  return updateSubscription(subscriptionId, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
  });
}

async function hasActiveSubscriptionInPeriod(restaurantId) {
  const now = new Date();
  const snapshot = await db
    .collection(COLLECTION_NAME)
    .where('restaurantId', '==', restaurantId)
    .where('status', '==', 'active')
    .get();

  if (snapshot.empty) {
    return false;
  }

  // Check if any active subscription hasn't expired yet
  for (const doc of snapshot.docs) {
    const subscription = doc.data();
    if (subscription.endDate) {
      const endDate = new Date(subscription.endDate);
      if (endDate > now) {
        return true; // Has active subscription that hasn't expired
      }
    } else {
      return true; // No end date means it's still active
    }
  }

  return false;
}

async function renewSubscription(subscriptionId) {
  const docRef = db.collection(COLLECTION_NAME).doc(subscriptionId);
  const doc = await docRef.get();
  
  if (!doc.exists) {
    throw new Error('Subscription not found');
  }

  const subscription = doc.data();
  const now = new Date();
  
  // Calculate new end date
  let newEndDate = null;
  const previousEndDate = subscription.endDate ? new Date(subscription.endDate) : now;
  
  if (subscription.billingCycle === 'monthly') {
    newEndDate = new Date(previousEndDate);
    newEndDate.setMonth(newEndDate.getMonth() + 1);
  } else if (subscription.billingCycle === 'yearly') {
    newEndDate = new Date(previousEndDate);
    newEndDate.setFullYear(newEndDate.getFullYear() + 1);
  }

  const updateData = {
    startDate: now.toISOString(),
    endDate: newEndDate ? newEndDate.toISOString() : null,
    updatedAt: now.toISOString(),
  };

  await docRef.update(updateData);
  const updatedDoc = await docRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
}

module.exports = {
  createSubscription,
  getSubscriptionByRestaurantId,
  listSubscriptions,
  updateSubscription,
  cancelSubscription,
  hasActiveSubscriptionInPeriod,
  renewSubscription,
};
