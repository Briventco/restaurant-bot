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
  buildManualPaymentInstructionsMessage,
  buildUnavailableItemsMessage,
  buildAwaitingCustomerUpdatePrompt,
  buildAwaitingCustomerEditPrompt,
  buildOrderSummaryLineItems,
  buildOrderRejectedMessage,
  buildOrderCancelledMessage,
  buildOrderReadyMessage,
  buildRestaurantOrderAlertMessage,
  buildRestaurantPaymentAlertMessage,
  buildRestaurantTestAlertMessage,
} = require("../templates/messages");
const { buildShortOrderCode } = require("../utils/orderReference");

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

function toValidQuantityOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.max(1, Math.round(parsed));
}

function buildItemNameAliases(name) {
  const raw = String(name || "").trim();
  if (!raw) {
    return [];
  }

  const aliases = new Set();
  const push = (value) => {
    const normalized = normalizeText(value);
    if (normalized) {
      aliases.add(normalized);
    }
  };

  push(raw);

  const withoutParens = raw.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (withoutParens) {
    push(withoutParens);
  }

  return Array.from(aliases);
}

function matchMenuItems(orderItems, menuItems) {
  const normalizedMenu = new Map();
  for (const item of menuItems || []) {
    for (const alias of buildItemNameAliases(item && item.name)) {
      if (!normalizedMenu.has(alias)) {
        normalizedMenu.set(alias, item);
      }
    }
  }

  const matched = [];
  const unavailable = [];
  const invalidQuantities = [];

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

    const quantity = toValidQuantityOrNull(orderItem.quantity);
    if (!quantity) {
      invalidQuantities.push(found.name);
      continue;
    }

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
    invalidQuantities,
  };
}

function normalizeMatchedItemsForPricing(matched) {
  return (Array.isArray(matched) ? matched : []).map((item) => {
    const quantity = toValidQuantityOrNull(item && item.quantity);
    if (!quantity) {
      throw createHttpError(
        400,
        `Invalid quantity for ${String((item && item.name) || "item").trim() || "item"}`
      );
    }

    const price = Number(item && item.price) || 0;

    return {
      ...item,
      quantity,
      price,
      subtotal: price * quantity,
    };
  });
}

function buildTimestampPatchForStatus(toStatus) {
  const nowIso = new Date().toISOString();
  const statusFields = {
    [ORDER_STATUSES.CONFIRMED]: "confirmedAt",
    [ORDER_STATUSES.PREPARING]: "preparingAt",
    [ORDER_STATUSES.READY_FOR_PICKUP]: "readyForPickupAt",
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
  conversationSessionRepo,
  alertSenderNumber = "09130123219",
  alertSenderRestaurantId = "",
  fallbackAlertSenderRestaurantId = "",
  logger = null,
}) {
  function normalizePhoneLike(value) {
    return String(value || "").replace(/[^0-9]/g, "");
  }

  function logAlertError(message, meta = {}) {
    if (logger && typeof logger.error === "function") {
      logger.error(message, meta);
      return;
    }

    if (logger && typeof logger.warn === "function") {
      logger.warn(message, meta);
    }
  }

  function buildPhoneCandidates(value) {
    const raw = String(value || "").trim();
    const digits = normalizePhoneLike(raw);
    const variants = new Set();

    if (raw) {
      variants.add(raw);
    }
    if (digits) {
      variants.add(digits);
    }

    if (digits.startsWith("0") && digits.length === 11) {
      variants.add(`234${digits.slice(1)}`);
    }
    if (digits.startsWith("234") && digits.length >= 12) {
      variants.add(`0${digits.slice(3)}`);
    }

    const numericForms = Array.from(variants).filter((item) => /^\d+$/.test(item));
    for (const form of numericForms) {
      variants.add(`${form}@c.us`);
      variants.add(`${form}@lid`);
    }

    return Array.from(variants).filter(Boolean);
  }

  function buildStaffAlertSessionRecipients(recipient) {
    return buildPhoneCandidates(recipient);
  }

  function getRestaurantRecordId(restaurant) {
    return String(
      (restaurant && (restaurant.id || restaurant.restaurantId)) || ""
    ).trim();
  }

  function getRestaurantWhatsappNumber(restaurant) {
    const whatsapp =
      restaurant && restaurant.whatsapp && typeof restaurant.whatsapp === "object"
        ? restaurant.whatsapp
        : {};

    return String(whatsapp.phone || whatsapp.phoneNumber || "").trim();
  }

  function getRestaurantProfilePhone(restaurant) {
    return String((restaurant && restaurant.phone) || "").trim();
  }

  function getCustomerDisplayName(customer) {
    return String(
      (customer &&
        (customer.displayName || customer.customerName || customer.name || customer.fullName)) ||
        ""
    ).trim();
  }

  function getManualPaymentConfig(restaurant) {
    const payment =
      restaurant && restaurant.payment && typeof restaurant.payment === "object"
        ? restaurant.payment
        : {};

    return {
      manualTransferEnabled: payment.manualTransferEnabled === true,
      bankName: String(payment.bankName || "").trim(),
      accountName: String(payment.accountName || "").trim(),
      accountNumber: String(payment.accountNumber || "").trim(),
      paymentInstructions: String(payment.paymentInstructions || "").trim(),
    };
  }

  function getOrderAlertRecipients(restaurant) {
    const profilePhone = getRestaurantProfilePhone(restaurant);
    return profilePhone ? [profilePhone] : [];
  }

  async function resolveRestaurantAlertSenderContext() {
    const configuredSenderRestaurantId = String(alertSenderRestaurantId || "").trim();
    const fallbackSenderRestaurantId = String(
      fallbackAlertSenderRestaurantId || ""
    ).trim();
    const configuredSenderNumber =
      String(alertSenderNumber || "").trim() || "09130123219";

    if (configuredSenderRestaurantId) {
      const senderRestaurant = await restaurantRepo.getRestaurantById(
        configuredSenderRestaurantId
      );
      if (senderRestaurant) {
        return {
          senderRestaurantId:
            getRestaurantRecordId(senderRestaurant) || configuredSenderRestaurantId,
          senderNumber:
            getRestaurantWhatsappNumber(senderRestaurant) || configuredSenderNumber,
          resolution: "restaurant_id",
        };
      }

      logAlertError("notifyRestaurantOrderAlert: sender restaurant not found", {
        senderRestaurantId: configuredSenderRestaurantId,
        senderNumber: configuredSenderNumber,
      });
    }

    if (
      fallbackSenderRestaurantId &&
      fallbackSenderRestaurantId !== configuredSenderRestaurantId
    ) {
      const senderRestaurant = await restaurantRepo.getRestaurantById(
        fallbackSenderRestaurantId
      );
      if (senderRestaurant) {
        return {
          senderRestaurantId:
            getRestaurantRecordId(senderRestaurant) || fallbackSenderRestaurantId,
          senderNumber:
            getRestaurantWhatsappNumber(senderRestaurant) || configuredSenderNumber,
          resolution: "default_restaurant_id",
        };
      }
    }

    if (
      configuredSenderNumber &&
      restaurantRepo &&
      typeof restaurantRepo.findRestaurantByWhatsappBinding === "function"
    ) {
      const senderRestaurant = await restaurantRepo.findRestaurantByWhatsappBinding({
        phone: configuredSenderNumber,
      });
      if (senderRestaurant) {
        return {
          senderRestaurantId: getRestaurantRecordId(senderRestaurant),
          senderNumber:
            getRestaurantWhatsappNumber(senderRestaurant) || configuredSenderNumber,
          resolution: "whatsapp_phone_binding",
        };
      }
    }

    return {
      senderRestaurantId: "",
      senderNumber: configuredSenderNumber,
      resolution: "unresolved",
    };
  }

  function buildRestaurantAlertDeliveryStatus(outboxResult) {
    const finalStatus = (outboxResult.message && outboxResult.message.status) || "queued";

    if (finalStatus === "sent") {
      return outboxResult.duplicate ? "sent_duplicate_suppressed" : "sent";
    }
    if (finalStatus === "failed") {
      return "failed";
    }
    if (finalStatus === "processing") {
      return "processing";
    }
    return "queued_for_retry";
  }

  function buildRestaurantAlertAuditMetadata({
    recipient,
    senderRestaurantId,
    senderNumber,
    messageType,
    sourceAction,
    outboxResult,
    deliveryStatus,
    metadata,
  }) {
    return {
      ...metadata,
      internalAlert: true,
      alertRecipient: recipient,
      senderRestaurantId,
      senderNumber,
      sourceAction,
      messageType,
      deliveryStatus,
      outboxMessageId: outboxResult.message ? outboxResult.message.id : "",
      outboxStatus: outboxResult.message ? outboxResult.message.status : "queued",
      outboxAttemptCount: outboxResult.message
        ? Number(outboxResult.message.attemptCount || 0)
        : 0,
      duplicateSuppressed: Boolean(outboxResult.duplicate),
    };
  }

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

  async function sendRestaurantAlertMessage({
    order,
    recipient,
    text,
    metadata = {},
    senderContext = null,
  }) {
    const normalizedRecipient = String(recipient || "").trim();
    const messageType =
      String(metadata.type || "restaurant_alert").trim() || "restaurant_alert";
    const sourceAction =
      String(metadata.sourceAction || "restaurantAlert").trim() || "restaurantAlert";
    const sourceRef = String(metadata.sourceRef || order.id || "").trim();
    const resolvedSenderContext =
      senderContext && String(senderContext.senderRestaurantId || "").trim()
        ? senderContext
        : await resolveRestaurantAlertSenderContext();

    if (!resolvedSenderContext.senderRestaurantId) {
      const senderError = new Error(
        `Servra alert sender ${resolvedSenderContext.senderNumber || alertSenderNumber} is not configured`
      );
      senderError.code = "SERVRA_ALERT_SENDER_NOT_CONFIGURED";
      senderError.retryable = false;
      throw senderError;
    }

    const outboxResult = await outboxService.enqueueAndMaybeDispatch({
      restaurantId: order.restaurantId,
      channel: order.channel,
      recipient: normalizedRecipient,
      text,
      messageType,
      sourceAction,
      sourceRef,
      idempotencyKey:
        String(metadata.idempotencyKey || "").trim() ||
        [
          "restaurant_alert",
          order.restaurantId,
          order.id,
          sourceAction,
          normalizePhoneLike(normalizedRecipient) || "none",
        ].join(":"),
      metadata: {
        orderId: order.id,
        internalAlert: true,
        alertRecipient: normalizedRecipient,
        senderRestaurantId: resolvedSenderContext.senderRestaurantId,
        senderNumber: resolvedSenderContext.senderNumber,
        ...metadata,
      },
    });

    const deliveryStatus = buildRestaurantAlertDeliveryStatus(outboxResult);
    const auditMetadata = buildRestaurantAlertAuditMetadata({
      recipient: normalizedRecipient,
      senderRestaurantId: resolvedSenderContext.senderRestaurantId,
      senderNumber: resolvedSenderContext.senderNumber,
      messageType,
      sourceAction,
      outboxResult,
      deliveryStatus,
      metadata,
    });

    try {
      await orderRepo.addOrderMessage(order.restaurantId, order.id, {
        restaurantId: order.restaurantId,
        channel: order.channel,
        channelCustomerId: normalizedRecipient,
        customerPhone: normalizePhoneLike(normalizedRecipient),
        direction: "outbound",
        text,
        metadata: auditMetadata,
      });
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("sendRestaurantAlertMessage: failed to log order alert message", {
          restaurantId: order.restaurantId,
          orderId: order.id,
          recipient: normalizedRecipient,
          error: error && error.message ? error.message : String(error || ""),
        });
      }
    }

    if (logger && typeof logger.info === "function") {
      logger.info("Restaurant order alert queued for delivery", {
        restaurantId: order.restaurantId,
        orderId: order.id,
        senderRestaurantId: resolvedSenderContext.senderRestaurantId,
        senderNumber: resolvedSenderContext.senderNumber,
        recipient: normalizedRecipient,
        messageType,
        outboxStatus: outboxResult.message ? outboxResult.message.status : "queued",
        deliveryStatus,
      });
    }

    return {
      deliveryStatus,
      senderRestaurantId: resolvedSenderContext.senderRestaurantId,
      senderNumber: resolvedSenderContext.senderNumber,
      recipient: normalizedRecipient,
      outboxMessageId: outboxResult.message ? outboxResult.message.id : "",
      outboxStatus: outboxResult.message ? outboxResult.message.status : "queued",
      duplicateSuppressed: Boolean(outboxResult.duplicate),
      messageType,
    };
  }

  async function notifyRestaurantOrderAlert(order) {
    const restaurant = await restaurantRepo.getRestaurantById(order.restaurantId);
    if (!restaurant) {
      if (logger) {
        logger.warn("notifyRestaurantOrderAlert: restaurant not found", {
          restaurantId: order.restaurantId,
        });
      }
      return;
    }

    const bot =
      restaurant && restaurant.bot && typeof restaurant.bot === "object"
        ? restaurant.bot
        : {};

    if (bot.notifyOnOrder === false) {
      return;
    }

    const primaryRecipients = getOrderAlertRecipients(restaurant);
    const restaurantProfilePhone = getRestaurantProfilePhone(restaurant);

    if (!primaryRecipients.length) {
      logAlertError("notifyRestaurantOrderAlert: restaurant profile phone is missing", {
        restaurantId: order.restaurantId,
        orderId: order.id,
        restaurantName: String(restaurant.name || "").trim(),
        restaurantProfilePhone,
      });
      return;
    }

    const senderContext = await resolveRestaurantAlertSenderContext();
    if (!senderContext.senderRestaurantId) {
      logAlertError("notifyRestaurantOrderAlert: sender line could not be resolved", {
        restaurantId: order.restaurantId,
        orderId: order.id,
        senderNumber: senderContext.senderNumber,
        configuredSenderRestaurantId: String(alertSenderRestaurantId || "").trim(),
      });
      return;
    }

    if (logger && typeof logger.info === "function") {
      logger.info("Restaurant order alert recipient resolved from restaurant profile phone", {
        restaurantId: order.restaurantId,
        orderId: order.id,
        senderRestaurantId: senderContext.senderRestaurantId,
        senderNumber: senderContext.senderNumber,
        restaurantProfilePhone,
        recipients: primaryRecipients,
      });
    }

    const alertText = buildRestaurantOrderAlertMessage({
      ...order,
      shortCode: buildShortOrderCode(order && order.id),
      restaurantName: String(restaurant.name || "").trim(),
      orderTime: order.createdAt || new Date().toISOString(),
    });

    await Promise.all(
      primaryRecipients.map(async (recipient) => {
        try {
          const dispatchResult = await sendRestaurantAlertMessage({
            order,
            recipient,
            text: alertText,
            metadata: {
              type: "restaurant_order_alert",
              sourceAction: "newOrderAlert",
              sourceRef: order.id,
            },
            senderContext,
          });

          if (
            conversationSessionRepo &&
            dispatchResult &&
            dispatchResult.deliveryStatus !== "failed"
          ) {
            const sessionRecipients = buildStaffAlertSessionRecipients(recipient);
            await Promise.all(
              sessionRecipients.map((sessionRecipient) =>
                conversationSessionRepo.upsertSession(
                  order.restaurantId,
                  order.channel,
                  sessionRecipient,
                  {
                    state: "awaiting_staff_order_action",
                    role: "restaurant_staff_alert",
                    orderId: order.id,
                    alertType: "new_order",
                  }
                )
              )
            );
          }

          if (logger && typeof logger.info === "function") {
            logger.info("Restaurant order alert delivery recorded", {
              restaurantId: order.restaurantId,
              orderId: order.id,
              senderRestaurantId: dispatchResult.senderRestaurantId,
              senderNumber: dispatchResult.senderNumber,
              recipient: dispatchResult.recipient,
              outboxStatus: dispatchResult.outboxStatus,
              deliveryStatus: dispatchResult.deliveryStatus,
            });
          }
        } catch (alertError) {
          if (logger) {
            logger.warn("notifyRestaurantOrderAlert: failed to send alert to restaurant recipient", {
              restaurantId: order.restaurantId,
              orderId: order.id,
              senderRestaurantId: senderContext.senderRestaurantId,
              senderNumber: senderContext.senderNumber,
              recipient,
              error: alertError && alertError.message,
            });
          }
        }
      })
    );
  }

  async function sendRestaurantTestAlert({ restaurantId, requestedBy = "" }) {
    const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
    if (!restaurant) {
      throw createHttpError(404, "Restaurant not found");
    }

    const recipients = getOrderAlertRecipients(restaurant);
    if (!recipients.length) {
      throw createHttpError(
        409,
        "Restaurant profile phone is required before order alerts can be sent."
      );
    }

    const testOrder = {
      id: `test-alert-${Date.now()}`,
      restaurantId,
      channel: "whatsapp-web",
    };

    const results = await Promise.all(
      recipients.map(async (recipient) => {
        try {
          const dispatchResult = await sendRestaurantAlertMessage({
            order: testOrder,
            recipient,
            text: buildRestaurantTestAlertMessage(restaurant),
            metadata: {
              type: "restaurant_test_alert",
              sourceAction: "sendRestaurantTestAlert",
              sourceRef: requestedBy || "settings",
            },
          });

          const finalStatus =
            (dispatchResult && dispatchResult.outboxStatus) || "queued";

          return {
            recipient,
            ok: finalStatus === "sent" || finalStatus === "queued" || finalStatus === "processing",
            status: finalStatus,
            error: "",
          };
        } catch (error) {
          return {
            recipient,
            ok: false,
            status: "failed",
            error: error && error.message ? error.message : "Failed to send test alert",
          };
        }
      })
    );

    return {
      restaurantId,
      results,
    };
  }

  function getPaymentAlertRecipients(restaurant) {
    const bot =
      restaurant && restaurant.bot && typeof restaurant.bot === "object"
        ? restaurant.bot
        : {};

    const paymentRecipients = Array.isArray(bot.paymentAlertRecipients)
      ? bot.paymentAlertRecipients
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [];

    if (paymentRecipients.length) {
      return paymentRecipients;
    }

    return getOrderAlertRecipients(restaurant);
  }

  async function notifyRestaurantPaymentAlert(order, options = {}) {
    const restaurant = await restaurantRepo.getRestaurantById(order.restaurantId);
    if (!restaurant) {
      return;
    }

    const recipients = getPaymentAlertRecipients(restaurant);
    if (!recipients.length) {
      return;
    }

    const alertText = buildRestaurantPaymentAlertMessage(
      {
        ...order,
        shortCode: buildShortOrderCode(order && order.id),
      },
      {
        note: options.note || "",
      }
    );

    await Promise.all(
      recipients.map(async (recipient) => {
        await sendRestaurantAlertMessage({
          order,
          recipient,
          text: alertText,
          metadata: {
            type: "restaurant_payment_alert",
            sourceAction: "paymentReportedAlert",
            sourceRef: order.id,
          },
        });
      })
    );
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

  async function listCurrentOrders({ restaurantId, limit }) {
    const requestedLimit = Number(limit) > 0 ? Number(limit) : 50;
    const recentOrders = await orderRepo.listOrders(restaurantId, {
      limit: Math.max(requestedLimit, 100),
    });

    return recentOrders
      .filter((order) => ACTIVE_ORDER_STATUSES.includes(String(order.status || "")))
      .slice(0, requestedLimit);
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
    const {
      matched,
      unavailable,
      invalidQuantities,
    } = matchMenuItems(parsedItems, menuItems);

    if (!matched.length || invalidQuantities.length) {
      return null;
    }

    const normalizedMatched = normalizeMatchedItemsForPricing(matched);
    const total = calculateTotal(normalizedMatched);

    const order = await orderRepo.createOrder(restaurantId, {
      restaurantId,
      customerId: customer.id,
      customerName: getCustomerDisplayName(customer),
      channel,
      channelCustomerId,
      customerPhone,
      source: channel,
      rawMessage: messageText,
      latestProviderMessageId: providerMessageId || "",
      matched: normalizedMatched,
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

    if (logger && typeof logger.info === "function") {
      logger.info("Order created", {
        restaurantId,
        orderId: order.id,
        customerName: String(order.customerName || "").trim(),
        customerPhone: String(order.customerPhone || "").trim(),
        fulfillmentType: String(order.fulfillmentType || "pickup").trim() || "pickup",
        total: Number(order.total || 0),
        sourceAction: "createNewOrderFromInbound",
      });
    }

    await notifyRestaurantOrderAlert(order);

    return order;
  }

  async function resolveRequestedItems({ restaurantId, messageText }) {
    const menuItems = await menuRepo.listMenuItems(restaurantId);
    const parsedItems = await orderParsingService.parseOrder(messageText, menuItems);
    return matchMenuItems(parsedItems, menuItems);
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
    deliveryPhone = "",
    deliveryFee = 0,
  }) {
    const safeQuantity = toValidQuantityOrNull(quantity);
    if (!safeQuantity) {
      throw createHttpError(400, "Quantity must be at least 1");
    }

    const matched = [
      {
        menuItemId: menuItem.id,
        name: menuItem.name,
        price: Number(menuItem.price) || 0,
        quantity: safeQuantity,
        subtotal: (Number(menuItem.price) || 0) * safeQuantity,
      },
    ];
    const subtotal = calculateTotal(matched);
    const safeFee = fulfillmentType === "delivery" ? (Number(deliveryFee) || 0) : 0;
    const total = subtotal + safeFee;
    const rawMessage =
      fulfillmentType === "delivery" && deliveryAddress
        ? `${safeQuantity} ${menuItem.name} delivery ${deliveryAddress}`
        : `${safeQuantity} ${menuItem.name} ${fulfillmentType || "pickup"}`;

    const order = await orderRepo.createOrder(restaurantId, {
      restaurantId,
      customerId: customer.id,
      customerName: getCustomerDisplayName(customer),
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
      subtotal,
      deliveryFee: safeFee,
      total,
      status: ORDER_STATUSES.PENDING_CONFIRMATION,
      paymentMethod: "manual_bank_transfer",
      paymentState: "not_started",
      fulfillmentType: fulfillmentType || "pickup",
      deliveryAddress: deliveryAddress || "",
      deliveryPhone: deliveryPhone || "",
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

    if (logger && typeof logger.info === "function") {
      logger.info("Order created", {
        restaurantId,
        orderId: order.id,
        customerName: String(order.customerName || "").trim(),
        customerPhone: String(order.customerPhone || "").trim(),
        fulfillmentType: String(order.fulfillmentType || "pickup").trim() || "pickup",
        total: Number(order.total || 0),
        sourceAction: "createGuidedOrder",
      });
    }

    await notifyRestaurantOrderAlert(order);

    return order;
  }

  async function createGuidedOrderFromItems({
    restaurantId,
    customer,
    channel,
    channelCustomerId,
    customerPhone,
    providerMessageId,
    matched,
    fulfillmentType,
    deliveryAddress,
    deliveryPhone = "",
    deliveryFee = 0,
    rawMessage = "",
  }) {
    const safeMatched = normalizeMatchedItemsForPricing(
      Array.isArray(matched) ? matched.filter(Boolean) : []
    );
    if (!safeMatched.length) {
      throw createHttpError(400, "At least one matched item is required");
    }

    const subtotal = calculateTotal(safeMatched);
    const safeFee = fulfillmentType === "delivery" ? (Number(deliveryFee) || 0) : 0;
    const total = subtotal + safeFee;

    const order = await orderRepo.createOrder(restaurantId, {
      restaurantId,
      customerId: customer.id,
      customerName: getCustomerDisplayName(customer),
      channel,
      channelCustomerId,
      customerPhone,
      source: channel,
      rawMessage:
        String(rawMessage || "").trim() ||
        safeMatched
          .map((item) => `${item.quantity} ${item.name}`)
          .join(" and "),
      latestProviderMessageId: providerMessageId || "",
      matched: safeMatched,
      unavailable: [],
      unavailableItems: [],
      issueType: "",
      staffNote: "",
      subtotal,
      deliveryFee: safeFee,
      total,
      status: ORDER_STATUSES.PENDING_CONFIRMATION,
      paymentMethod: "manual_bank_transfer",
      paymentState: "not_started",
      fulfillmentType: fulfillmentType || "pickup",
      deliveryAddress: deliveryAddress || "",
      deliveryPhone: deliveryPhone || "",
      summaryText: buildOrderSummaryLineItems(safeMatched),
    });

    await orderRepo.addStatusHistory(restaurantId, order.id, {
      fromStatus: null,
      toStatus: ORDER_STATUSES.PENDING_CONFIRMATION,
      actorType: "system",
      actorId: "guided_whatsapp_flow",
      reason: "guided_multi_item_order_created",
      metadata: {
        providerMessageId: providerMessageId || "",
        fulfillmentType: fulfillmentType || "pickup",
        itemCount: safeMatched.length,
      },
    });

    if (logger && typeof logger.info === "function") {
      logger.info("Order created", {
        restaurantId,
        orderId: order.id,
        customerName: String(order.customerName || "").trim(),
        customerPhone: String(order.customerPhone || "").trim(),
        fulfillmentType: String(order.fulfillmentType || "pickup").trim() || "pickup",
        total: Number(order.total || 0),
        sourceAction: "createGuidedOrderFromItems",
      });
    }

    await notifyRestaurantOrderAlert(order);

    return order;
  }

  async function updatePendingOrderFromCustomer({
    restaurantId,
    orderId,
    matched,
    fulfillmentType,
    deliveryAddress,
    rawMessage,
    providerMessageId,
    actor,
    reason = "customer_updated_pending_order",
  }) {
    const order = await getOrderOrThrow(restaurantId, orderId);
    const safeMatched = normalizeMatchedItemsForPricing(
      Array.isArray(matched) ? matched.filter(Boolean) : order.matched || []
    );
    if (!safeMatched.length) {
      throw createHttpError(400, "At least one matched item is required");
    }

    const patch = {
      matched: safeMatched,
      total: calculateTotal(safeMatched),
      summaryText: buildOrderSummaryLineItems(safeMatched),
      rawMessage: String(rawMessage || order.rawMessage || "").trim(),
      latestProviderMessageId: String(providerMessageId || order.latestProviderMessageId || "").trim(),
    };

    if (fulfillmentType) {
      patch.fulfillmentType = fulfillmentType;
      patch.deliveryAddress = fulfillmentType === "delivery" ? String(deliveryAddress || "").trim() : "";
    } else if (deliveryAddress !== undefined) {
      patch.deliveryAddress = String(deliveryAddress || "").trim();
    }

    const updatedOrder = await orderRepo.updateOrder(restaurantId, orderId, patch);

    await orderRepo.addStatusHistory(restaurantId, orderId, {
      fromStatus: order.status,
      toStatus: updatedOrder.status,
      actorType: (actor && actor.type) || "customer",
      actorId: (actor && actor.id) || order.channelCustomerId,
      reason,
      metadata: {
        fulfillmentType: patch.fulfillmentType || updatedOrder.fulfillmentType || "",
        itemCount: safeMatched.length,
      },
    });

    return updatedOrder;
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
    const { matched, unavailable, invalidQuantities } = matchMenuItems(parsedItems, menuItems);

    if (invalidQuantities.length) {
      return {
        handled: true,
        order: activeOrder,
        reply: `Please use a quantity of at least 1 for: ${invalidQuantities.join(", ")}.`,
      };
    }

    if (!matched.length) {
      return {
        handled: true,
        order: activeOrder,
        reply:
          "I couldn't detect a valid updated order.\n\nPlease send something like:\n2 jollof rice and 1 beef",
      };
    }

    const normalizedMatched = normalizeMatchedItemsForPricing(matched);
    const total = calculateTotal(normalizedMatched);
    const updatedOrder = await orderRepo.updateOrder(restaurantId, activeOrder.id, {
      rawMessage: incomingMessage,
      matched: normalizedMatched,
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
      reply: buildOrderUpdatedMessage({ matched: normalizedMatched, total, unavailable }),
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
    const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
    if (!restaurant) {
      throw createHttpError(404, "Restaurant not found");
    }

    const paymentConfig = getManualPaymentConfig(restaurant);

    if (paymentConfig.manualTransferEnabled) {
      if (
        !paymentConfig.bankName ||
        !paymentConfig.accountName ||
        !paymentConfig.accountNumber
      ) {
        throw createHttpError(
          409,
          "Manual payment is enabled, but bank transfer details are incomplete."
        );
      }

      const updatedOrder = await transitionOrderStatus({
        restaurantId,
        orderId,
        toStatus: ORDER_STATUSES.AWAITING_PAYMENT,
        actor,
        reason: "order_accepted_awaiting_payment",
      });

      const orderAfterPaymentState = await orderRepo.updateOrder(restaurantId, orderId, {
        paymentState: "pending_transfer",
      });

      await sendMessageToOrderCustomer(
        orderAfterPaymentState || updatedOrder,
        buildManualPaymentInstructionsMessage({
          total: updatedOrder.total,
          bankName: paymentConfig.bankName,
          accountName: paymentConfig.accountName,
          accountNumber: paymentConfig.accountNumber,
          note: paymentConfig.paymentInstructions,
        }),
        {
          type: "payment_prompt",
          sourceAction: "confirmOrderAwaitingPayment",
          sourceRef: orderId,
          bankName: paymentConfig.bankName,
          accountName: paymentConfig.accountName,
          accountNumber: paymentConfig.accountNumber,
        }
      );

      return orderAfterPaymentState || updatedOrder;
    }

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

  async function cancelOrder({ restaurantId, orderId, actor, note = "" }) {
    const trimmedNote = String(note || "").trim();
    const updatedOrder = await transitionOrderStatus({
      restaurantId,
      orderId,
      toStatus: ORDER_STATUSES.CANCELLED,
      actor,
      reason: "staff_cancelled_order",
      metadata: {
        note: trimmedNote,
      },
    });

    await sendMessageToOrderCustomer(
      updatedOrder,
      buildOrderCancelledMessage(trimmedNote),
      {
        type: "order_cancelled",
        sourceAction: "cancelOrder",
        sourceRef: orderId,
        note: trimmedNote,
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
    } else if (
      order.status === ORDER_STATUSES.CONFIRMED ||
      order.status === ORDER_STATUSES.PREPARING
    ) {
      updatedOrder = await transitionOrderStatus({
        restaurantId,
        orderId,
        toStatus: ORDER_STATUSES.READY_FOR_PICKUP,
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

  async function cancelCurrentOrdersForCustomer({
    restaurantId,
    channelCustomerId,
    channel = "",
    actor,
    reason = "test_cleanup_cancel_active_orders",
  }) {
    const normalizedCustomerId = String(channelCustomerId || "").trim();
    const normalizedChannel = String(channel || "").trim();

    if (!normalizedCustomerId) {
      throw createHttpError(400, "channelCustomerId is required");
    }

    const activeOrders = await listCurrentOrders({
      restaurantId,
      limit: 200,
    });

    const matchingOrders = activeOrders.filter((order) => {
      const sameCustomer =
        String(order.channelCustomerId || "").trim() === normalizedCustomerId;
      const sameChannel = normalizedChannel
        ? String(order.channel || "").trim() === normalizedChannel
        : true;

      return sameCustomer && sameChannel;
    });

    const cancelled = [];
    const skipped = [];

    for (const order of matchingOrders) {
      const decision = canTransition({
        fromStatus: order.status,
        toStatus: ORDER_STATUSES.CANCELLED,
        restaurantConfig: null,
      });

      if (!decision.allowed) {
        skipped.push({
          id: order.id,
          status: order.status,
          reason: decision.reason,
        });
        continue;
      }

      const updatedOrder = await transitionOrderStatus({
        restaurantId,
        orderId: order.id,
        toStatus: ORDER_STATUSES.CANCELLED,
        actor,
        reason,
        metadata: {
          cleanup: true,
        },
      });

      cancelled.push({
        id: updatedOrder.id,
        status: updatedOrder.status,
      });
    }

    return {
      channelCustomerId: normalizedCustomerId,
      channel: normalizedChannel,
      matchedCount: matchingOrders.length,
      cancelledCount: cancelled.length,
      skippedCount: skipped.length,
      cancelled,
      skipped,
    };
  }

  return {
    calculateTotal,
    matchMenuItems,
    listOrders,
    listCurrentOrders,
    getOrder,
    listOrderMessages,
    getOrderOrThrow,
    createNewOrderFromInbound,
    resolveRequestedItems,
    createGuidedOrder,
    createGuidedOrderFromItems,
    updatePendingOrderFromCustomer,
    findActiveOrderByCustomer,
    handleAwaitingCustomerUpdate,
    handleAwaitingCustomerEdit,
    transitionOrderStatus,
    markItemsUnavailable,
    confirmOrder,
    rejectOrder,
    cancelOrder,
    markOrderReady,
    cancelCurrentOrdersForCustomer,
    sendMessageToOrderCustomer,
    sendRestaurantAlertMessage,
    notifyRestaurantPaymentAlert,
    sendRestaurantTestAlert,
    logInboundMessage,
  };
}

module.exports = {
  createOrderService,
  calculateTotal,
  matchMenuItems,
};
