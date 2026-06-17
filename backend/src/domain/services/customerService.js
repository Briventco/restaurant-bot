function createCustomerService({ customerRepo }) {
  async function upsertCustomerFromChannelMessage({
    restaurantId,
    channel,
    channelCustomerId,
    customerPhone,
    displayName,
  }) {
    return customerRepo.upsertByChannelIdentity({
      restaurantId,
      channel,
      channelCustomerId,
      customerPhone,
      displayName,
    });
  }

  async function getCustomerByPhone({ restaurantId, customerPhone }) {
    return customerRepo.findCustomerByPhone({
      restaurantId,
      customerPhone,
    });
  }

  return {
    upsertCustomerFromChannelMessage,
    getCustomerByPhone,
  };
}

module.exports = {
  createCustomerService,
};
