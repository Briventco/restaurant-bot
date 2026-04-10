const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

function restaurantRef(restaurantId) {
  return db.collection("restaurants").doc(restaurantId);
}

async function getRestaurantById(restaurantId) {
  const snapshot = await restaurantRef(restaurantId).get();
  if (!snapshot.exists) {
    return null;
  }

  return serializeDoc(snapshot);
}

async function upsertRestaurant(restaurantId, data) {
  const ref = restaurantRef(restaurantId);
  const snapshot = await ref.get();

  if (snapshot.exists) {
    await ref.set(
      {
        ...data,
        restaurantId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.set({
      ...data,
      restaurantId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const latest = await ref.get();
  return serializeDoc(latest);
}

async function listRestaurants(options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 100;
  const snapshot = await db
    .collection("restaurants")
    .orderBy("createdAt", "desc")
    .limit(Math.max(1, Math.min(200, limit)))
    .get();

  return snapshot.docs.map((doc) => serializeDoc(doc));
}

function normalizeWhatsappBindingValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizePhoneLikeValue(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

async function findRestaurantByWhatsappBinding(binding = {}) {
  const provider = normalizeWhatsappBindingValue(binding.provider);
  const phoneNumberId = normalizeWhatsappBindingValue(binding.phoneNumberId);
  const wabaId = normalizeWhatsappBindingValue(binding.wabaId);
  const phone = normalizePhoneLikeValue(binding.phone);

  if (!provider && !phoneNumberId && !wabaId && !phone) {
    return null;
  }

  const restaurants = await listRestaurants({ limit: 200 });

  return (
    restaurants.find((restaurant) => {
      const whatsapp =
        restaurant && restaurant.whatsapp && typeof restaurant.whatsapp === "object"
          ? restaurant.whatsapp
          : {};

      const restaurantProvider = normalizeWhatsappBindingValue(whatsapp.provider);
      const restaurantPhoneNumberId = normalizeWhatsappBindingValue(whatsapp.phoneNumberId);
      const restaurantWabaId = normalizeWhatsappBindingValue(whatsapp.wabaId);
      const restaurantPhone = normalizePhoneLikeValue(
        whatsapp.phone || whatsapp.phoneNumber || ""
      );

      if (provider && restaurantProvider && provider !== restaurantProvider) {
        return false;
      }

      if (phoneNumberId && restaurantPhoneNumberId && phoneNumberId === restaurantPhoneNumberId) {
        return true;
      }

      if (wabaId && restaurantWabaId && wabaId === restaurantWabaId) {
        return true;
      }

      if (phone && restaurantPhone && phone === restaurantPhone) {
        return true;
      }

      return false;
    }) || null
  );
}

module.exports = {
  getRestaurantById,
  upsertRestaurant,
  listRestaurants,
  findRestaurantByWhatsappBinding,
};
