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

  return {
    upsertCustomerFromChannelMessage,
  };
}

module.exports = {
  createCustomerService,
};
