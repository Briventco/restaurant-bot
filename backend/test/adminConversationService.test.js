const test = require("node:test");
const assert = require("node:assert/strict");
const {
  matchesChannelCustomerId,
  buildCustomerActivityList,
} = require("../src/domain/services/adminConversationService");
const { customerDocId } = require("../src/repositories/customerRepo");

test("matchesChannelCustomerId accepts lid and c.us variants", () => {
  const candidates = ["249512434073771@lid", "249512434073771@c.us", "249512434073771"];

  assert.equal(matchesChannelCustomerId("249512434073771@c.us", candidates), true);
  assert.equal(matchesChannelCustomerId("249512434073771@lid", candidates), true);
});

test("buildCustomerActivityList prefers the newest order activity", async () => {
  const customerId = customerDocId("whatsapp-web", "2348012345678@c.us");
  const items = await buildCustomerActivityList({
    restaurantId: "servra",
    customerRepo: {
      listCustomers: async () => [
        {
          id: customerId,
          channel: "whatsapp-web",
          channelCustomerId: "2348012345678@c.us",
          customerPhone: "+2348012345678",
          displayName: "Tunde",
          updatedAt: "2026-05-30T10:48:00.000Z",
        },
      ],
    },
    orderRepo: {
      listOrders: async () => [
        {
          channel: "whatsapp-web",
          channelCustomerId: "2348012345678@c.us",
          customerPhone: "+2348012345678",
          createdAt: "2026-06-10T12:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].lastActivityAt, "2026-06-10T12:00:00.000Z");
  assert.equal(items[0].orderCount, 1);
});
