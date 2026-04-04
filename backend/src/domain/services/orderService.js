const crypto = require("crypto");
const {
  ORDER_STATUSES,
  ACTIVE_ORDER_STATUSES,
  ALL_ORDER_STATUSES,
} = require("../constants/orderStatuses");
const { canTransition } = require("../policies/orderTransitions");
const { normalizeText } = require("../utils/text");
const { createHttpError } = require("../utils/httpError");
const {
  buildOrderUpdatedMessage,
  buildConfirmMessage,
  buildUnavailableItemsMessage,
  buildAwaitingCustomerUpdatePrompt,
  buildAwaitingCustomerEditPrompt,
  buildOrderSummaryLineItems,
  buildOrderRejectedMessage,
  buildOrderReadyMessage,
} = require("../templates/messages");

function calculateTotal(items) {
  return (items || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
}

function toSafeQuantity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }

  return Math.max(1, Math.round(parsed));
}

function matchMenuItems(orderItems, menuItems) {
  const normalizedMenu = new Map(
    (menuItems || []).map((item) => [normalizeText(item.name), item])
  );

  const matched = [];
  const unavailable = [];

  for (const orderItem of orderItems || []) {
    const found = normalizedMenu.get(normalizeText(orderItem.name));

    if (!found) {
      unavailable.push(orderItem.name);
      continue;
    }

    if (!found.available) {
      unavailable.push(found.name);
      continue;
    }

    const quantity = toSafeQuantity(orderItem.quantity);
    matched.push({
      menuItemId: found.id,
      name: found.name,
      price: Number(found.price) || 0,
      quantity,
      subtotal: (Number(found.price) || 0) * quantity,
    });
  }

  return {
    matched,
    unavailable,
  };
}

function buildTimestampPatchForStatus(toStatus) {
  const nowIso = new Date().toISOString();
  const statusFields = {
    [ORDER_STATUSES.CONFIRMED]: "confirmedAt",
    [ORDER_STATUSES.PREPARING]: "preparingAt",
    [ORDER_STATUSES.RIDER_DISPATCHED]: "riderDispatchedAt",
    [ORDER_STATUSES.DELIVERED]: "deliveredAt",
    [ORDER_STATUSES.CANCELLED]: "cancelledAt",
    [ORDER_STATUSES.AWAITING_PAYMENT]: "awaitingPaymentAt",
    [ORDER_STATUSES.PAYMENT_REVIEW]: "paymentReviewAt",
  };

  const field = statusFields[toStatus];
  if (!field) {
    return {};
  }

  return {
    [field]: nowIso,
  };
}

function createOrderService({
  menuRepo,
  orderRepo,
  restaurantRepo,
  orderParsingService,
  outboxService,
}) {
  function hashText(value) {
    return crypto.createHash("sha1").update(String(value || "")).digest("hex");
  }

  async function getOrderOrThrow(restaurantId, orderId) {
    const order = await orderRepo.getOrderById(restaurantId, orderId);
    if (!order) {
      throw createHttpError(404, "Order not found");
    }

    return order;
  }

  async function sendMessageToOrderCustomer(order, text, metadata = {}) {
    const messageType = String(metadata.type || "generic").trim() || "generic";
    const sourceAction = String(metadata.sourceAction || messageType).trim() || messageType;
    const sourceRef = String(metadata.sourceRef || order.id || "").trim();
    const idempotencySeed = String(
      metadata.idempotencySeed || metadata.providerMessageId || ""
    ).trim();
    const idempotencyKey =
      String(metadata.idempotencyKey || "").trim() ||
      [
        "order_outbound",
        order.restaurantId,
        order.id,
        sourceAction,
        messageType,
        sourceRef || "none",
        idempotencySeed || "none",
        hashText(text),
      ].join(":");

    const outboxResult = await outboxService.enqueueAndMaybeDispatch({
      restaurantId: order.restaurantId,
      channel: order.channel,
      recipient: order.channelCustomerId,
      text,
      messageType,
      sourceAction,
      sourceRef,
      idempotencyKey,
      metadata: {
        orderId: order.id,
        channelCustomerId: order.channelCustomerId,
        customerPhone: order.customerPhone,
        ...metadata,
      },
    });

    const finalStatus = (outboxResult.message && outboxResult.message.status) || "queued";
    let deliveryStatus = "queued_for_retry";

    if (finalStatus === "sent") {
      deliveryStatus = outboxResult.duplicate
        ? "sent_duplicate_suppressed"
        : "sent";
    } else if (finalStatus === "failed") {
      deliveryStatus = "failed";
    } else if (finalStatus === "processing") {
      deliveryStatus = "processing";
    }

    await orderRepo.addOrderMessage(order.restaurantId, order.id, {
      restaurantId: order.restaurantId,
      channel: order.channel,
      channelCustomerId: order.channelCustomerId,
      customerPhone: order.customerPhone,
      direction: "outbound",
      text,
      metadata: {
        ...metadata,
        sourceAction,
        messageType,
        deliveryStatus,
        outboxMessageId: outboxResult.message ? outboxResult.message.id : "",
        outboxStatus: finalStatus,
        outboxAttemptCount: outboxResult.message
          ? Number(outboxResult.message.attemptCount || 0)
          : 0,
        duplicateSuppressed: Boolean(outboxResult.duplicate),
      },
    });

    return {
      deliveryStatus,
    };
  }

  async function logInboundMessage(order, text, metadata = {}) {
    await orderRepo.addOrderMessage(order.restaurantId, order.id, {
      restaurantId: order.restaurantId,
      channel: order.channel,
      channelCustomerId: order.channelCustomerId,
      customerPhone: order.customerPhone,
      direction: "inbound",
      text,
      metadata,
    });
  }

  async function listOrders({ restaurantId, status, limit }) {
    return orderRepo.listOrders(restaurantId, { status, limit });
  }

  async function getOrder({ restaurantId, orderId }) {
    return getOrderOrThrow(restaurantId, orderId);
  }

  async function listOrderMessages({ restaurantId, orderId, limit }) {
    const order = await getOrderOrThrow(restaurantId, orderId);
    const messages = await orderRepo.listOrderMessages(restaurantId, orderId, { limit });
    return {
      orderId: order.id,
      status: order.status,
      messages,
    };
  }

  async function findActiveOrderByCustomer({
    restaurantId,
    channel,
    channelCustomerId,
  }) {
    return orderRepo.findActiveOrderByCustomer({
      restaurantId,
      channel,
      channelCustomerId,
      activeStatuses: ACTIVE_ORDER_STATUSES,
    });
  }

  async function createNewOrderFromInbound({
    restaurantId,
    customer,
    channel,
    channelCustomerId,
    customerPhone,
    messageText,
    providerMessageId,
  }) {
    const menuItems = await menuRepo.listMenuItems(restaurantId);
    const parsedItems = await orderParsingService.parseOrder(messageText, menuItems);
    const { matched, unavailable } = matchMenuItems(parsedItems, menuItems);

    if (!matched.length) {
      return null;
    }

    const total = calculateTotal(matched);

    const order = await orderRepo.createOrder(restaurantId, {
      restaurantId,
      customerId: customer.id,
      channel,
      channelCustomerId,
      customerPhone,
      source: channel,
      rawMessage: messageText,
      latestProviderMessageId: providerMessageId || "",
      matched,
      unavailable,
      unavailableItems: [],
      issueType: "",
      staffNote: "",
      total,
      status: ORDER_STATUSES.PENDING_CONFIRMATION,
      paymentMethod: "manual_bank_transfer",
      paymentState: "not_started",
    });

    await orderRepo.addStatusHistory(restaurantId, order.id, {
      fromStatus: null,
      toStatus: ORDER_STATUSES.PENDING_CONFIRMATION,
      actorType: "system",
      actorId: "inbound_message",
      reason: "new_order_created",
      metadata: {
        providerMessageId: providerMessageId || "",
      },
    });

    return order;
  }

  async function createGuidedOrder({
    restaurantId,
    customer,
    channel,
    channelCustomerId,
    customerPhone,
    providerMessageId,
    menuItem,
    quantity,
    fulfillmentType,
    deliveryAddress,
  }) {
    const safeQuantity = toSafeQuantity(quantity);
    const matched = [
      {
        menuItemId: menuItem.id,
        name: menuItem.name,
        price: Number(menuItem.price) || 0,
        quantity: safeQuantity,
        subtotal: (Number(menuItem.price) || 0) * safeQuantity,
      },
    ];
    const total = calculateTotal(matched);
    const rawMessage =
      fulfillmentType === "delivery" && deliveryAddress
        ? `${safeQuantity} ${menuItem.name} delivery ${deliveryAddress}`
        : `${safeQuantity} ${menuItem.name} ${fulfillmentType || "pickup"}`;

    const order = await orderRepo.createOrder(restaurantId, {
      restaurantId,
      customerId: customer.id,
      channel,
      channelCustomerId,
      customerPhone,
      source: channel,
      rawMessage,
      latestProviderMessageId: providerMessageId || "",
      matched,
      unavailable: [],
      unavailableItems: [],
      issueType: "",
      staffNote: "",
      total,
      status: ORDER_STATUSES.PENDING_CONFIRMATION,
      paymentMethod: "manual_bank_transfer",
      paymentState: "not_started",
      fulfillmentType: fulfillmentType || "pickup",
      deliveryAddress: deliveryAddress || "",
      summaryText: buildOrderSummaryLineItems(matched),
    });

    await orderRepo.addStatusHistory(restaurantId, order.id, {
      fromStatus: null,
      toStatus: ORDER_STATUSES.PENDING_CONFIRMATION,
      actorType: "system",
      actorId: "guided_whatsapp_flow",
      reason: "guided_order_created",
      metadata: {
        providerMessageId: providerMessageId || "",
        fulfillmentType: fulfillmentType || "pickup",
      },
    });

    return order;
  }

  async function handleAwaitingCustomerUpdate({
    restaurantId,
    activeOrder,
    incomingMessage,
  }) {
    const lower = normalizeText(incomingMessage);
    const unavailableItems = activeOrder.unavailableItems || [];

    if (lower === "1" || lower === "continue") {
      const filteredMatched = (activeOrder.matched || []).filter(
        (item) => !unavailableItems.includes(item.name)
      );

      if (!filteredMatched.length) {
        return {
          handled: true,
          order: activeOrder,
          reply:
            "No items remain after removing unavailable items. Reply 2 to edit your order or 3 to cancel.",
        };
      }

      const total = calculateTotal(filteredMatched);
      const updatedOrder = await orderRepo.updateOrder(restaurantId, activeOrder.id, {
        matched: filteredMatched,
        total,
        status: ORDER_STATUSES.PENDING_CONFIRMATION,
        unavailableItems: [],
        issueType: "",
        staffNote: "",
      });

      await orderRepo.addStatusHistory(restaurantId, activeOrder.id, {
        fromStatus: activeOrder.status,
        toStatus: ORDER_STATUSES.PENDING_CONFIRMATION,
        actorType: "customer",
        actorId: activeOrder.channelCustomerId,
        reason: "customer_continue_without_unavailable",
      });

      return {
        handled: true,
        order: updatedOrder,
        reply: buildOrderUpdatedMessage({
          matched: filteredMatched,
          total,
          unavailable: [],
        }),
      };
    }

    if (lower === "2" || lower === "edit" || lower === "edit order") {
      const updatedOrder = await orderRepo.updateOrder(restaurantId, activeOrder.id, {
        status: ORDER_STATUSES.AWAITING_CUSTOMER_EDIT,
      });

      await orderRepo.addStatusHistory(restaurantId, activeOrder.id, {
        fromStatus: activeOrder.status,
        toStatus: ORDER_STATUSES.AWAITING_CUSTOMER_EDIT,
        actorType: "customer",
        actorId: activeOrder.channelCustomerId,
        reason: "customer_requested_edit",
      });

      return {
        handled: true,
        order: updatedOrder,
        reply: buildAwaitingCustomerEditPrompt(),
      };
    }

    if (lower === "3" || lower === "cancel") {
      const updatedOrder = await transitionOrderStatus({
        restaurantId,
        orderId: activeOrder.id,
        toStatus: ORDER_STATUSES.CANCELLED,
        actor: {
          type: "customer",
          id: activeOrder.channelCustomerId,
        },
        reason: "customer_cancelled_after_unavailable_notice",
      });

      return {
        handled: true,
        order: updatedOrder,
        reply: "Your order has been cancelled.",
      };
    }

    return {
      handled: true,
      order: activeOrder,
      reply: buildAwaitingCustomerUpdatePrompt(),
    };
  }

  async function handleAwaitingCustomerEdit({
    restaurantId,
    activeOrder,
    incomingMessage,
  }) {
    const menuItems = await menuRepo.listMenuItems(restaurantId);
    const parsedItems = await orderParsingService.parseOrder(incomingMessage, menuItems);
    const { matched, unavailable } = matchMenuItems(parsedItems, menuItems);

    if (!matched.length) {
      return {
        handled: true,
        order: activeOrder,
        reply:
          "I couldn't detect a valid updated order.\n\nPlease send something like:\n2 jollof rice and 1 beef",
      };
    }

    const total = calculateTotal(matched);
    const updatedOrder = await orderRepo.updateOrder(restaurantId, activeOrder.id, {
      rawMessage: incomingMessage,
      matched,
      unavailable,
      total,
      status: ORDER_STATUSES.PENDING_CONFIRMATION,
      issueType: "",
      unavailableItems: [],
      staffNote: "",
    });

    await orderRepo.addStatusHistory(restaurantId, activeOrder.id, {
      fromStatus: activeOrder.status,
      toStatus: ORDER_STATUSES.PENDING_CONFIRMATION,
      actorType: "customer",
      actorId: activeOrder.channelCustomerId,
      reason: "customer_submitted_order_edit",
    });

    return {
      handled: true,
      order: updatedOrder,
      reply: buildOrderUpdatedMessage({ matched, total, unavailable }),
    };
  }

  async function transitionOrderStatus({
    restaurantId,
    orderId,
    toStatus,
    actor,
    reason,
    metadata,
  }) {
    if (!ALL_ORDER_STATUSES.includes(toStatus)) {
      throw createHttpError(400, "Invalid toStatus");
    }

    const order = await getOrderOrThrow(restaurantId, orderId);
    const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
    if (!restaurant) {
      throw createHttpError(404, "Restaurant not found");
    }

    const decision = canTransition({
      fromStatus: order.status,
      toStatus,
      restaurantConfig: restaurant,
    });

    if (!decision.allowed) {
      throw createHttpError(400, decision.reason, {
        fromStatus: order.status,
        toStatus,
        allowedTransitions: decision.allowedTransitions || [],
      });
    }

    const updatedOrder = await orderRepo.transitionStatusWithHistory({
      restaurantId,
      orderId,
      fromStatus: order.status,
      toStatus,
      actor,
      reason,
      metadata,
      patch: buildTimestampPatchForStatus(toStatus),
    });

    return updatedOrder;
  }

  async function markItemsUnavailable({
    restaurantId,
    orderId,
    items,
    note,
    actor,
  }) {
    const uniqueItems = [...new Set((items || []).map((item) => String(item).trim()))].filter(
      Boolean
    );

    if (!uniqueItems.length) {
      throw createHttpError(400, "At least one unavailable item is required");
    }

    const transitionedOrder = await transitionOrderStatus({
      restaurantId,
      orderId,
      toStatus: ORDER_STATUSES.AWAITING_CUSTOMER_UPDATE,
      actor: {
        type: (actor && actor.type) || "staff",
        id: (actor && actor.id) || null,
      },
      reason: "staff_marked_items_unavailable",
      metadata: {
        items: uniqueItems,
      },
    });

    const updatedOrder = await orderRepo.updateOrder(restaurantId, orderId, {
      status: ORDER_STATUSES.AWAITING_CUSTOMER_UPDATE,
      issueType: "items_unavailable",
      unavailableItems: uniqueItems,
      staffNote: note || "",
    });

    const customerMessage = buildUnavailableItemsMessage(uniqueItems, note || "");

    await sendMessageToOrderCustomer(updatedOrder || transitionedOrder, customerMessage, {
      type: "unavailable_items_notice",
      sourceAction: "markItemsUnavailable",
      sourceRef: `${orderId}:${uniqueItems.join("|")}`,
      items: uniqueItems,
    });

    return updatedOrder || transitionedOrder;
  }

  async function confirmOrder({ restaurantId, orderId, actor }) {
    const updatedOrder = await transitionOrderStatus({
      restaurantId,
      orderId,
      toStatus: ORDER_STATUSES.CONFIRMED,
      actor,
      reason: "order_confirmed",
    });

    await sendMessageToOrderCustomer(
      updatedOrder,
      buildConfirmMessage(updatedOrder.total),
      {
        type: "order_confirmed",
        sourceAction: "confirmOrder",
        sourceRef: orderId,
      }
    );

    return updatedOrder;
  }

  async function rejectOrder({ restaurantId, orderId, actor, note = "" }) {
    const updatedOrder = await transitionOrderStatus({
      restaurantId,
      orderId,
      toStatus: ORDER_STATUSES.CANCELLED,
      actor,
      reason: "order_rejected",
      metadata: {
        note: String(note || "").trim(),
      },
    });

    await sendMessageToOrderCustomer(
      updatedOrder,
      buildOrderRejectedMessage(String(note || "").trim()),
      {
        type: "order_rejected",
        sourceAction: "rejectOrder",
        sourceRef: orderId,
        note: String(note || "").trim(),
      }
    );

    return updatedOrder;
  }

  async function markOrderReady({ restaurantId, orderId, actor }) {
    const order = await getOrderOrThrow(restaurantId, orderId);
    const fulfillmentType = String(order.fulfillmentType || "pickup").trim().toLowerCase();

    if (
      order.status !== ORDER_STATUSES.CONFIRMED &&
      order.status !== ORDER_STATUSES.PREPARING &&
      order.status !== ORDER_STATUSES.RIDER_DISPATCHED
    ) {
      throw createHttpError(
        400,
        `Order cannot be marked ready from status ${order.status}`
      );
    }

    let updatedOrder = order;

    if (fulfillmentType === "delivery") {
      if (order.status === ORDER_STATUSES.CONFIRMED) {
        updatedOrder = await transitionOrderStatus({
          restaurantId,
          orderId,
          toStatus: ORDER_STATUSES.PREPARING,
          actor,
          reason: "kitchen_ready_transition_prepairing",
        });
      }

      if (updatedOrder.status === ORDER_STATUSES.PREPARING) {
        updatedOrder = await transitionOrderStatus({
          restaurantId,
          orderId,
          toStatus: ORDER_STATUSES.RIDER_DISPATCHED,
          actor,
          reason: "order_ready_for_dispatch",
        });
      }
    } else if (order.status === ORDER_STATUSES.CONFIRMED) {
      updatedOrder = await transitionOrderStatus({
        restaurantId,
        orderId,
        toStatus: ORDER_STATUSES.PREPARING,
        actor,
        reason: "order_ready_for_pickup",
        metadata: {
          readyForPickup: true,
        },
      });
    }

    await sendMessageToOrderCustomer(
      updatedOrder,
      buildOrderReadyMessage({ fulfillmentType }),
      {
        type: "order_ready",
        sourceAction: "markOrderReady",
        sourceRef: orderId,
        fulfillmentType,
      }
    );

    return updatedOrder;
  }

  return {
    calculateTotal,
    matchMenuItems,
    listOrders,
    getOrder,
    listOrderMessages,
    getOrderOrThrow,
    createNewOrderFromInbound,
    createGuidedOrder,
    findActiveOrderByCustomer,
    handleAwaitingCustomerUpdate,
    handleAwaitingCustomerEdit,
    transitionOrderStatus,
    markItemsUnavailable,
    confirmOrder,
    rejectOrder,
    markOrderReady,
    sendMessageToOrderCustomer,
    logInboundMessage,
  };
}

module.exports = {
  createOrderService,
  calculateTotal,
  matchMenuItems,
};
