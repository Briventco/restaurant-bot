const test = require("node:test");
const assert = require("node:assert/strict");

const { canTransition } = require("../src/domain/policies/orderTransitions");
const { ORDER_STATUSES } = require("../src/domain/constants/orderStatuses");

test("pending_confirmation -> awaiting_payment is blocked by default", () => {
  const result = canTransition({
    fromStatus: ORDER_STATUSES.PENDING_CONFIRMATION,
    toStatus: ORDER_STATUSES.AWAITING_PAYMENT,
    restaurantConfig: {},
  });

  assert.equal(result.allowed, false);
});

test("pending_confirmation -> awaiting_payment allowed when restaurant flow enables it", () => {
  const result = canTransition({
    fromStatus: ORDER_STATUSES.PENDING_CONFIRMATION,
    toStatus: ORDER_STATUSES.AWAITING_PAYMENT,
    restaurantConfig: {
      flow: {
        allowDirectAwaitingPaymentFromPending: true,
      },
    },
  });

  assert.equal(result.allowed, true);
});

test("awaiting_payment -> payment_review is allowed", () => {
  const result = canTransition({
    fromStatus: ORDER_STATUSES.AWAITING_PAYMENT,
    toStatus: ORDER_STATUSES.PAYMENT_REVIEW,
    restaurantConfig: {},
  });

  assert.equal(result.allowed, true);
});
