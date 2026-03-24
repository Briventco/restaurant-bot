const test = require("node:test");
const assert = require("node:assert/strict");

const { createOrderService } = require("../src/domain/services/orderService");
const { ORDER_STATUSES } = require("../src/domain/constants/orderStatuses");

test("customer edit flow updates the same order id", async () => {
  const activeOrder = {
    id: "order-123",
    restaurantId: "rest-1",
    status: ORDER_STATUSES.AWAITING_CUSTOMER_EDIT,
    channel: "whatsapp-web",
    channelCustomerId: "234000000000@c.us",
    customerPhone: "+234000000000",
    matched: [{ name: "egg", quantity: 1, subtotal: 300 }],
    unavailable: [],
  };

  let updatedOrderId = null;

  const orderService = createOrderService({
    menuRepo: {
      listMenuItems: async () => [
        { id: "item-1", name: "egg", price: 300, available: true },
      ],
    },
    orderRepo: {
      getOrderById: async () => activeOrder,
      updateOrder: async (_restaurantId, orderId, patch) => {
        updatedOrderId = orderId;
        return {
          ...activeOrder,
          ...patch,
          id: orderId,
        };
      },
      addStatusHistory: async () => ({}),
      transitionStatusWithHistory: async () => activeOrder,
      listOrders: async () => [],
      findActiveOrderByCustomer: async () => activeOrder,
      createOrder: async () => activeOrder,
      addOrderMessage: async () => ({}),
    },
    restaurantRepo: {
      getRestaurantById: async () => ({ id: "rest-1" }),
    },
    orderParsingService: {
      parseOrder: async () => [{ name: "egg", quantity: 2 }],
    },
    outboxService: {
      enqueueAndMaybeDispatch: async () => ({
        message: { id: "outbox-1", status: "sent", attemptCount: 1 },
        duplicate: false,
      }),
    },
  });

  const result = await orderService.handleAwaitingCustomerEdit({
    restaurantId: "rest-1",
    activeOrder,
    incomingMessage: "2 egg",
  });

  assert.equal(updatedOrderId, "order-123");
  assert.equal(result.order.id, "order-123");
  assert.equal(result.order.status, ORDER_STATUSES.PENDING_CONFIRMATION);
});
