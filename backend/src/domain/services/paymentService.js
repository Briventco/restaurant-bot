const { ORDER_STATUSES } = require("../constants/orderStatuses");
const {
  buildPaymentConfirmedMessage,
  buildPaymentRejectedMessage,
} = require("../templates/messages");

function createPaymentService({ paymentReceiptRepo, orderRepo, orderService }) {
  async function resolveReviewReceipt({ restaurantId, order, receiptId }) {
    const normalizedReceiptId = String(receiptId || "").trim();
    if (normalizedReceiptId) {
      const receipt = await paymentReceiptRepo.getPaymentReceiptById(
        restaurantId,
        order.id,
        normalizedReceiptId
      );
      if (!receipt) {
        return null;
      }
      return receipt;
    }

    const latestPaymentReceiptId = String(order.latestPaymentReceiptId || "").trim();
    if (latestPaymentReceiptId) {
      return paymentReceiptRepo.getPaymentReceiptById(
        restaurantId,
        order.id,
        latestPaymentReceiptId
      );
    }

    const receipts = await paymentReceiptRepo.listPaymentReceipts(restaurantId, order.id);
    return receipts[0] || null;
  }

  async function submitPaymentReceipt({
    restaurantId,
    orderId,
    receiptUrl,
    amount,
    reference,
    note,
    submittedBy,
  }) {
    const order = await orderService.getOrderOrThrow(restaurantId, orderId);

    const receipt = await paymentReceiptRepo.createPaymentReceipt(restaurantId, orderId, {
      restaurantId,
      orderId,
      receiptUrl,
      amount,
      reference,
      note: note || "",
      submittedBy: submittedBy || "",
      channel: order.channel,
      channelCustomerId: order.channelCustomerId,
      customerPhone: order.customerPhone,
      status: "submitted",
    });

    let updatedOrder = order;

    if (order.status === ORDER_STATUSES.AWAITING_PAYMENT) {
      updatedOrder = await orderService.transitionOrderStatus({
        restaurantId,
        orderId,
        toStatus: ORDER_STATUSES.PAYMENT_REVIEW,
        actor: {
          type: "staff",
          id: submittedBy || "staff",
        },
        reason: "payment_receipt_submitted",
      });
    }

    updatedOrder = await orderRepo.updateOrder(restaurantId, orderId, {
      paymentState:
        updatedOrder.status === ORDER_STATUSES.PAYMENT_REVIEW
          ? "under_review"
          : "receipt_submitted",
      latestPaymentReceiptId: receipt.id,
    });

    return {
      receipt,
      order: updatedOrder,
    };
  }

  async function listPaymentReceipts({ restaurantId, orderId }) {
    return paymentReceiptRepo.listPaymentReceipts(restaurantId, orderId);
  }

  async function markCustomerPaymentReported({
    restaurantId,
    orderId,
    actorId,
    note = "",
    providerMessageId = "",
  }) {
    const order = await orderService.getOrderOrThrow(restaurantId, orderId);

    if (
      order.status !== ORDER_STATUSES.AWAITING_PAYMENT &&
      order.status !== ORDER_STATUSES.PAYMENT_REVIEW
    ) {
      const error = new Error(
        `Order must be in ${ORDER_STATUSES.AWAITING_PAYMENT} or ${ORDER_STATUSES.PAYMENT_REVIEW} to report payment`
      );
      error.statusCode = 409;
      throw error;
    }

    let transitioned = order;
    if (order.status === ORDER_STATUSES.AWAITING_PAYMENT) {
      transitioned = await orderService.transitionOrderStatus({
        restaurantId,
        orderId,
        toStatus: ORDER_STATUSES.PAYMENT_REVIEW,
        actor: {
          type: "customer",
          id: actorId || order.channelCustomerId,
        },
        reason: "customer_reported_payment",
        metadata: {
          note: String(note || "").trim(),
          providerMessageId: String(providerMessageId || "").trim(),
        },
      });
    }

    const updatedOrder = await orderRepo.updateOrder(restaurantId, orderId, {
      paymentState: "under_review",
      paymentReportedAt: new Date().toISOString(),
      paymentReportNote: String(note || "").trim(),
      latestProviderMessageId: String(providerMessageId || order.latestProviderMessageId || "").trim(),
    });

    return updatedOrder || transitioned;
  }

  async function confirmPaymentReview({
    restaurantId,
    orderId,
    receiptId,
    actorId,
    note,
  }) {
    const order = await orderService.getOrderOrThrow(restaurantId, orderId);
    if (
      order.status !== ORDER_STATUSES.PAYMENT_REVIEW &&
      order.status !== ORDER_STATUSES.AWAITING_PAYMENT
    ) {
      const error = new Error(
        `Order must be in ${ORDER_STATUSES.PAYMENT_REVIEW} or ${ORDER_STATUSES.AWAITING_PAYMENT} to confirm payment`
      );
      error.statusCode = 409;
      throw error;
    }

    const receipt = await resolveReviewReceipt({ restaurantId, order, receiptId });

    const reviewedAt = new Date().toISOString();
    let updatedReceipt = null;
    if (receipt) {
      updatedReceipt = await paymentReceiptRepo.updatePaymentReceipt(
        restaurantId,
        orderId,
        receipt.id,
        {
          status: "approved",
          reviewedBy: String(actorId || ""),
          reviewNote: String(note || ""),
          reviewedAt,
        }
      );
    }

    let transitioned = order;
    if (order.status === ORDER_STATUSES.AWAITING_PAYMENT) {
      transitioned = await orderService.transitionOrderStatus({
        restaurantId,
        orderId,
        toStatus: ORDER_STATUSES.PAYMENT_REVIEW,
        actor: {
          type: "staff",
          id: actorId || "staff",
        },
        reason: "manual_payment_marked_for_review",
        metadata: {
          receiptId: receipt ? receipt.id : "",
        },
      });
    }

    transitioned = await orderService.transitionOrderStatus({
      restaurantId,
      orderId,
      toStatus: ORDER_STATUSES.CONFIRMED,
      actor: {
        type: "staff",
        id: actorId || "staff",
      },
      reason: "payment_review_confirmed",
      metadata: {
        receiptId: receipt ? receipt.id : "",
      },
    });

    const orderAfterPayment = await orderRepo.updateOrder(restaurantId, orderId, {
      paymentState: "paid",
      latestPaymentReceiptId: receipt ? receipt.id : String(order.latestPaymentReceiptId || ""),
      paymentReviewedAt: reviewedAt,
      paymentReviewedBy: String(actorId || ""),
    });

    await orderService.sendMessageToOrderCustomer(
      orderAfterPayment || transitioned,
      buildPaymentConfirmedMessage(),
      {
        type: "payment_confirmed",
        sourceAction: "confirmPaymentReview",
        sourceRef: orderId,
      }
    );

    return {
      order: orderAfterPayment || transitioned,
      receipt: updatedReceipt || receipt || null,
    };
  }

  async function rejectPaymentReview({
    restaurantId,
    orderId,
    receiptId,
    actorId,
    reason,
    note,
  }) {
    const order = await orderService.getOrderOrThrow(restaurantId, orderId);
    if (
      order.status !== ORDER_STATUSES.PAYMENT_REVIEW &&
      order.status !== ORDER_STATUSES.AWAITING_PAYMENT
    ) {
      const error = new Error(
        `Order must be in ${ORDER_STATUSES.PAYMENT_REVIEW} or ${ORDER_STATUSES.AWAITING_PAYMENT} to reject payment`
      );
      error.statusCode = 409;
      throw error;
    }

    const receipt = await resolveReviewReceipt({ restaurantId, order, receiptId });

    const reviewedAt = new Date().toISOString();
    let updatedReceipt = null;
    if (receipt) {
      updatedReceipt = await paymentReceiptRepo.updatePaymentReceipt(
        restaurantId,
        orderId,
        receipt.id,
        {
          status: "rejected",
          reviewedBy: String(actorId || ""),
          reviewReason: String(reason || "").trim(),
          reviewNote: String(note || ""),
          reviewedAt,
        }
      );
    }

    const transitioned = await orderService.transitionOrderStatus({
      restaurantId,
      orderId,
      toStatus: ORDER_STATUSES.AWAITING_PAYMENT,
      actor: {
        type: "staff",
        id: actorId || "staff",
      },
      reason: "payment_review_rejected",
      metadata: {
        receiptId: receipt ? receipt.id : "",
        reason: String(reason || "").trim(),
      },
    });

    const orderAfterPayment = await orderRepo.updateOrder(restaurantId, orderId, {
      paymentState: "rejected",
      latestPaymentReceiptId: receipt ? receipt.id : String(order.latestPaymentReceiptId || ""),
      paymentReviewedAt: reviewedAt,
      paymentReviewedBy: String(actorId || ""),
      paymentReviewReason: String(reason || "").trim(),
    });

    await orderService.sendMessageToOrderCustomer(
      orderAfterPayment || transitioned,
      buildPaymentRejectedMessage(String(reason || "").trim()),
      {
        type: "payment_rejected",
        sourceAction: "rejectPaymentReview",
        sourceRef: orderId,
        reason: String(reason || "").trim(),
      }
    );

    return {
      order: orderAfterPayment || transitioned,
      receipt: updatedReceipt || receipt || null,
    };
  }

  return {
    submitPaymentReceipt,
    listPaymentReceipts,
    markCustomerPaymentReported,
    confirmPaymentReview,
    rejectPaymentReview,
  };
}

module.exports = {
  createPaymentService,
};
