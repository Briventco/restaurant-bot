function createWhatsappSessionService({ channelSessionService }) {
  const channel = "whatsapp-web";

  async function start(restaurantId) {
    return channelSessionService.start({ channel, restaurantId });
  }

  async function getStatus(restaurantId) {
    return channelSessionService.getStatus({ channel, restaurantId });
  }

  async function getQr(restaurantId) {
    return channelSessionService.getQr({ channel, restaurantId });
  }

  return {
    start,
    getStatus,
    getQr,
  };
}

module.exports = {
  createWhatsappSessionService,
};
