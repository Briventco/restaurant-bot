const { db, FieldValue } = require("../infra/firebase");
const { serializeDoc } = require("../infra/serialize");

const DEFAULT_CHANNEL = "whatsapp-web";
const PROVIDER_SESSIONS_COLLECTION = "providerSessions";
const LEGACY_WHATSAPP_COLLECTION = "whatsappSessions";

function sanitizeChannel(channel) {
  return String(channel || DEFAULT_CHANNEL)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
}

function providerSessionDocId(restaurantId, channel) {
  return `${restaurantId}__${sanitizeChannel(channel)}`;
}

function providerSessionRef(restaurantId, channel) {
  return db
    .collection(PROVIDER_SESSIONS_COLLECTION)
    .doc(providerSessionDocId(restaurantId, channel));
}

function legacyWhatsappSessionRef(restaurantId) {
  return db.collection(LEGACY_WHATSAPP_COLLECTION).doc(restaurantId);
}

async function getSession(restaurantId, channel = DEFAULT_CHANNEL) {
  const normalizedChannel = sanitizeChannel(channel);
  const snapshot = await providerSessionRef(restaurantId, normalizedChannel).get();

  if (snapshot.exists) {
    return serializeDoc(snapshot);
  }

  if (normalizedChannel !== DEFAULT_CHANNEL) {
    return null;
  }

  const legacy = await legacyWhatsappSessionRef(restaurantId).get();
  if (!legacy.exists) {
    return null;
  }

  return {
    ...serializeDoc(legacy),
    channel: DEFAULT_CHANNEL,
  };
}

async function upsertSession(restaurantId, channelOrPatch, maybePatch) {
  const hasExplicitChannel = typeof channelOrPatch === "string";
  const channel = hasExplicitChannel ? channelOrPatch : DEFAULT_CHANNEL;
  const patch = hasExplicitChannel ? maybePatch || {} : channelOrPatch || {};
  const normalizedChannel = sanitizeChannel(channel);

  const ref = providerSessionRef(restaurantId, normalizedChannel);
  const snapshot = await ref.get();

  const payload = {
    ...patch,
    restaurantId,
    channel: normalizedChannel,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (snapshot.exists) {
    await ref.set(payload, { merge: true });
  } else {
    await ref.set({
      ...payload,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  if (normalizedChannel === DEFAULT_CHANNEL) {
    const legacyRef = legacyWhatsappSessionRef(restaurantId);
    const legacySnapshot = await legacyRef.get();
    const legacyPayload = {
      ...patch,
      restaurantId,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (legacySnapshot.exists) {
      await legacyRef.set(legacyPayload, { merge: true });
    } else {
      await legacyRef.set({
        ...legacyPayload,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }

  const latest = await ref.get();
  return serializeDoc(latest);
}

module.exports = {
  getSession,
  upsertSession,
  providerSessionDocId,
};
