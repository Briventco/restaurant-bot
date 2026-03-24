const providerSessionRepo = require("./providerSessionRepo");

async function getSession(restaurantId) {
  return providerSessionRepo.getSession(restaurantId, "whatsapp-web");
}

async function upsertSession(restaurantId, patch) {
  return providerSessionRepo.upsertSession(restaurantId, "whatsapp-web", patch);
}

module.exports = {
  getSession,
  upsertSession,
};
