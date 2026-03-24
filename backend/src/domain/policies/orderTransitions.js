const { ORDER_STATUSES } = require("../constants/orderStatuses");

const BASE_TRANSITIONS = {
  [ORDER_STATUSES.PENDING_CONFIRMATION]: [
    ORDER_STATUSES.AWAITING_CUSTOMER_UPDATE,
    ORDER_STATUSES.AWAITING_ADDRESS,
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.AWAITING_CUSTOMER_UPDATE]: [
    ORDER_STATUSES.PENDING_CONFIRMATION,
    ORDER_STATUSES.AWAITING_CUSTOMER_EDIT,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.AWAITING_CUSTOMER_EDIT]: [
    ORDER_STATUSES.PENDING_CONFIRMATION,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.AWAITING_ADDRESS]: [
    ORDER_STATUSES.AWAITING_PAYMENT,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.AWAITING_PAYMENT]: [
    ORDER_STATUSES.PAYMENT_REVIEW,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.PAYMENT_REVIEW]: [
    ORDER_STATUSES.AWAITING_PAYMENT,
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.CONFIRMED]: [
    ORDER_STATUSES.PREPARING,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.PREPARING]: [
    ORDER_STATUSES.RIDER_DISPATCHED,
    ORDER_STATUSES.CANCELLED,
  ],
  [ORDER_STATUSES.RIDER_DISPATCHED]: [ORDER_STATUSES.DELIVERED],
  [ORDER_STATUSES.DELIVERED]: [],
  [ORDER_STATUSES.CANCELLED]: [],
};

function getAllowedTransitions(fromStatus, restaurantConfig) {
  const allowed = [...(BASE_TRANSITIONS[fromStatus] || [])];
  const allowDirectPayment = Boolean(
    restaurantConfig &&
      restaurantConfig.flow &&
      restaurantConfig.flow.allowDirectAwaitingPaymentFromPending
  );

  if (
    fromStatus === ORDER_STATUSES.PENDING_CONFIRMATION &&
    allowDirectPayment &&
    !allowed.includes(ORDER_STATUSES.AWAITING_PAYMENT)
  ) {
    allowed.push(ORDER_STATUSES.AWAITING_PAYMENT);
  }

  return allowed;
}

function canTransition({ fromStatus, toStatus, restaurantConfig }) {
  if (!fromStatus || !toStatus) {
    return {
      allowed: false,
      reason: "Missing fromStatus or toStatus",
    };
  }

  if (fromStatus === toStatus) {
    return {
      allowed: true,
      reason: "No-op transition",
    };
  }

  const allowedTransitions = getAllowedTransitions(fromStatus, restaurantConfig);

  return {
    allowed: allowedTransitions.includes(toStatus),
    reason: allowedTransitions.includes(toStatus)
      ? "Transition allowed"
      : `Transition from ${fromStatus} to ${toStatus} is not allowed`,
    allowedTransitions,
  };
}

module.exports = {
  canTransition,
  getAllowedTransitions,
};
