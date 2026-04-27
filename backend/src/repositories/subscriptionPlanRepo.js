const { db } = require('../infra/firebase');

const COLLECTION_NAME = 'subscriptionPlans';

async function createPlan(planData) {
  const docRef = db.collection(COLLECTION_NAME).doc();
  const now = new Date().toISOString();
  
  const plan = {
    id: docRef.id,
    name: planData.name,
    description: planData.description,
    price: Number(planData.price),
    currency: planData.currency || 'NGN',
    billingCycle: planData.billingCycle || 'monthly',
    features: Array.isArray(planData.features) ? planData.features : [],
    maxOrders: Number(planData.maxOrders) || null,
    maxMenuItems: Number(planData.maxMenuItems) || null,
    maxDeliveryZones: Number(planData.maxDeliveryZones) || null,
    whatsappIncluded: planData.whatsappIncluded !== false,
    supportLevel: planData.supportLevel || 'standard',
    isActive: planData.isActive !== false,
    createdAt: now,
    updatedAt: now,
  };

  await docRef.set(plan);
  return plan;
}

async function getPlanById(planId) {
  const doc = await db.collection(COLLECTION_NAME).doc(planId).get();
  if (!doc.exists) {
    return null;
  }
  return { id: doc.id, ...doc.data() };
}

async function listPlans(options = {}) {
  const { includeInactive = false } = options;
  let query = db.collection(COLLECTION_NAME);
  
  if (!includeInactive) {
    query = query.where('isActive', '==', true);
  }

  const snapshot = await query.orderBy('price', 'asc').get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function updatePlan(planId, updates) {
  const docRef = db.collection(COLLECTION_NAME).doc(planId);
  const doc = await docRef.get();
  
  if (!doc.exists) {
    throw new Error('Subscription plan not found');
  }

  const updateData = {
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await docRef.update(updateData);
  const updatedDoc = await docRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
}

async function deletePlan(planId) {
  const docRef = db.collection(COLLECTION_NAME).doc(planId);
  const doc = await docRef.get();
  
  if (!doc.exists) {
    throw new Error('Subscription plan not found');
  }

  await docRef.delete();
  return { id: planId, deleted: true };
}

module.exports = {
  createPlan,
  getPlanById,
  listPlans,
  updatePlan,
  deletePlan,
};
