const test = require("node:test");
const assert = require("node:assert/strict");
const {
  matchesChannelCustomerId,
  buildCustomerActivityList,
  buildCustomerMessageTimeline,
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

test("buildCustomerMessageTimeline merges conversation and order messages", async () => {
  const customer = {
    id: customerDocId("whatsapp-web", "2348012345678@c.us"),
    channel: "whatsapp-web",
    channelCustomerId: "2348012345678@c.us",
    customerPhone: "+2348012345678",
    displayName: "Tunde",
  };

  const timeline = await buildCustomerMessageTimeline({
    restaurantId: "servra",
    customer,
    orderRepo: {
      listOrdersByCustomer: async () => [
        { id: "ord-1", channel: "whatsapp-web", channelCustomerId: customer.channelCustomerId },
      ],
      listOrderMessages: async () => [
        {
          id: "ord-msg-1",
          direction: "inbound",
          text: "Cancel",
          createdAtMs: 1710000000000,
          createdAt: "2026-03-09T10:00:00.000Z",
        },
      ],
    },
    conversationMessageRepo: {
      listMessagesByCustomer: async () => [
        {
          id: "conv-1",
          direction: "in",
          text: "Hello",
          createdAtMs: 1710003600000,
          createdAt: "2026-03-09T11:00:00.000Z",
          source: "conversation",
        },
      ],
    },
    outboxService: {
      listOutboxMessages: async () => [],
    },
    routingAuditRepo: {
      listRecentRoutingAudits: async () => [],
    },
    limit: 50,
  });

  assert.equal(timeline.items.length, 2);
  assert.equal(timeline.items[0].text, "Cancel");
  assert.equal(timeline.items[0].source, "order");
  assert.equal(timeline.items[1].text, "Hello");
  assert.equal(timeline.items[1].source, "conversation");
});
