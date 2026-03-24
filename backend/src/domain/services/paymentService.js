const { ORDER_STATUSES } = require("../constants/orderStatuses");

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

  async function confirmPaymentReview({
    restaurantId,
    orderId,
    receiptId,
    actorId,
    note,
  }) {
    const order = await orderService.getOrderOrThrow(restaurantId, orderId);
    if (order.status !== ORDER_STATUSES.PAYMENT_REVIEW) {
      const error = new Error(
        `Order must be in ${ORDER_STATUSES.PAYMENT_REVIEW} to confirm payment`
      );
      error.statusCode = 409;
      throw error;
    }

    const receipt = await resolveReviewReceipt({ restaurantId, order, receiptId });
    if (!receipt) {
      const error = new Error("Payment receipt not found");
      error.statusCode = 404;
      throw error;
    }

    const reviewedAt = new Date().toISOString();
    const updatedReceipt = await paymentReceiptRepo.updatePaymentReceipt(
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

    const transitioned = await orderService.transitionOrderStatus({
      restaurantId,
      orderId,
      toStatus: ORDER_STATUSES.CONFIRMED,
      actor: {
        type: "staff",
        id: actorId || "staff",
      },
      reason: "payment_review_confirmed",
      metadata: {
        receiptId: receipt.id,
      },
    });

    const orderAfterPayment = await orderRepo.updateOrder(restaurantId, orderId, {
      paymentState: "paid",
      latestPaymentReceiptId: receipt.id,
      paymentReviewedAt: reviewedAt,
      paymentReviewedBy: String(actorId || ""),
    });

    return {
      order: orderAfterPayment || transitioned,
      receipt: updatedReceipt || receipt,
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
    if (order.status !== ORDER_STATUSES.PAYMENT_REVIEW) {
      const error = new Error(
        `Order must be in ${ORDER_STATUSES.PAYMENT_REVIEW} to reject payment`
      );
      error.statusCode = 409;
      throw error;
    }

    const receipt = await resolveReviewReceipt({ restaurantId, order, receiptId });
    if (!receipt) {
      const error = new Error("Payment receipt not found");
      error.statusCode = 404;
      throw error;
    }

    const reviewedAt = new Date().toISOString();
    const updatedReceipt = await paymentReceiptRepo.updatePaymentReceipt(
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
        receiptId: receipt.id,
        reason: String(reason || "").trim(),
      },
    });

    const orderAfterPayment = await orderRepo.updateOrder(restaurantId, orderId, {
      paymentState: "rejected",
      latestPaymentReceiptId: receipt.id,
      paymentReviewedAt: reviewedAt,
      paymentReviewedBy: String(actorId || ""),
      paymentReviewReason: String(reason || "").trim(),
    });

    return {
      order: orderAfterPayment || transitioned,
      receipt: updatedReceipt || receipt,
    };
  }

  return {
    submitPaymentReceipt,
    listPaymentReceipts,
    confirmPaymentReview,
    rejectPaymentReview,
  };
}

module.exports = {
  createPaymentService,
};
