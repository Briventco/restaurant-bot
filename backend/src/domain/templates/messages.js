function formatMenu(menuItems) {
  return (menuItems || [])
    .filter((item) => item.available)
    .map((item) => `- ${item.name} - N${item.price}`)
    .join("\n");
}

function buildGuidedMenuList(menuItems) {
  return (menuItems || [])
    .filter((item) => item.available)
    .map((item, index) => `${index + 1}. ${item.name} - N${item.price}`)
    .join("\n");
}

function buildMenuWelcome(menuItems, restaurantName = "") {
  const safeRestaurantName = String(restaurantName || "").trim();
  const heading = safeRestaurantName
    ? `Welcome to ${safeRestaurantName}!`
    : "Welcome!";

  return `${heading}\n\nHere's our menu:\n${buildGuidedMenuList(
    menuItems
  )}\n\nReply with the number or item name.`;
}

function buildGreetingMessage(restaurantName = "") {
  const safeRestaurantName = String(restaurantName || "").trim();
  if (safeRestaurantName) {
    return `Hi, welcome to ${safeRestaurantName}.\n\nYou can ask for the menu, ask what we have in stock, or start an order whenever you're ready.`;
  }

  return "Hi. You can ask for the menu, ask what we have in stock, or start an order whenever you're ready.";
}

function buildStockAvailabilityMessage(menuItems) {
  const availableItems = (menuItems || []).filter((item) => item.available);
  if (!availableItems.length) {
    return "We do not have any available items in stock right now.";
  }

  return `Currently available items:\n${buildGuidedMenuList(
    availableItems
  )}\n\nIf you want to order, reply with the item name or ask me to show the menu.`;
}

function buildInvalidOrderMessage(menuItems) {
  return `I couldn't detect a valid order.\n\nHere is our menu:\n${formatMenu(menuItems)}`;
}

function buildOrderSummaryLineItems(matched) {
  return (matched || [])
    .map((item) => `${item.quantity} x ${item.name} = N${item.subtotal}`)
    .join("\n");
}

function buildCartSummaryText({ matched, itemName, quantity, total }) {
  if (Array.isArray(matched) && matched.length) {
    return buildOrderSummaryLineItems(matched);
  }

  return `${quantity} x ${itemName} = N${total}`;
}

function buildOrderReceivedMessage({ matched, total, unavailable }) {
  let text = "Thanks - your order has been received.\n\n";
  text += buildOrderSummaryLineItems(matched);
  text += `\n\nTotal: N${total}`;
  text += "\nStatus: Waiting for staff confirmation.";

  if (Array.isArray(unavailable) && unavailable.length) {
    text += `\nUnavailable: ${unavailable.join(", ")}`;
  }

  return text;
}

function buildOrderUpdatedMessage({ matched, total, unavailable }) {
  let text = "Your order has been updated.\n\n";
  text += buildOrderSummaryLineItems(matched);
  text += `\n\nTotal: N${total}`;
  text += "\nStatus: Waiting for staff confirmation.";

  if (Array.isArray(unavailable) && unavailable.length) {
    text += `\nUnavailable: ${unavailable.join(", ")}`;
  }

  return text;
}

function buildConfirmMessage(total) {
  return `Order confirmed.\n\nTotal: N${total}\nStatus: Preparing your order.`;
}

function buildManualPaymentInstructionsMessage({
  total,
  bankName = "",
  accountName = "",
  accountNumber = "",
  note = "",
}) {
  let text = `Your order has been accepted.\n\nTotal: N${total}\n\nPlease make payment by bank transfer using the details below:\n`;
  text += `Bank: ${bankName || "Not provided"}\n`;
  text += `Account Name: ${accountName || "Not provided"}\n`;
  text += `Account Number: ${accountNumber || "Not provided"}`;

  if (note) {
    text += `\n\n${note}`;
  }

  text +=
    "\n\nAfter payment, reply with: I HAVE PAID";
  text +=
    "\nThen send your order number or the name/number used for the transfer so we can confirm your payment.";
  return text;
}

function buildUnavailableItemsMessage(items, note) {
  let message = "Sorry.\n\n";
  message += "The following items are currently unavailable:\n";
  message += (items || []).map((item) => `- ${item}`).join("\n");

  if (note) {
    message += `\n\n${note}`;
  }

  message += "\n\nReply with one option:";
  message += "\n1 - Continue without unavailable items";
  message += "\n2 - Edit order";
  message += "\n3 - Cancel order";

  return message;
}

function buildAwaitingCustomerUpdatePrompt() {
  return "Please reply with one option:\n1 - Continue without unavailable items\n2 - Edit order\n3 - Cancel order";
}

function buildAwaitingCustomerEditPrompt() {
  return "Please send your updated order now.\n\nExample:\n2 jollof rice and 1 beef";
}

function buildNoPendingCancelMessage() {
  return "You do not have a pending order update to cancel.";
}

function buildSelectedItemPrompt(item, options = {}) {
  const prefix = String(options.prefix || "").trim();
  const base = `You selected ${item.name} - N${item.price}`;
  return prefix ? `${prefix}\n\n${base}\n\nHow many portions?` : `${base}\n\nHow many portions?`;
}

function buildDeliveryOrPickupPrompt({ matched, itemName, quantity, total, prefix = "" }) {
  const body = `Order Summary:\n${buildCartSummaryText({
    matched,
    itemName,
    quantity,
    total,
  })}\n\nDelivery or Pickup?\nReply D or P`;

  return prefix ? `${String(prefix).trim()}\n\n${body}` : body;
}

function buildAddressPrompt() {
  return "Please send your delivery address.";
}

function buildGuidedConfirmPrompt({
  matched,
  itemName,
  quantity,
  total,
  fulfillmentType,
  address,
  prefix = "",
}) {
  let text = prefix ? `${String(prefix).trim()}\n\nConfirm order?\n\n` : "Confirm order?\n\n";
  text += buildCartSummaryText({
    matched,
    itemName,
    quantity,
    total,
  });
  text += `\n${fulfillmentType === "delivery" ? "Delivery" : "Pickup"}`;

  if (fulfillmentType === "delivery" && address) {
    text += `\nAddress: ${address}`;
  }

  text += "\n\nReply YES or NO";
  return text;
}

function buildGuidedOrderConfirmedMessage() {
  return "Order confirmed! We will notify you when it is accepted.";
}

function buildActiveOrderExistsMessage(order) {
  const status = String((order && order.status) || "pending").replace(/_/g, " ");
  return `You already have an active order in progress.\n\nCurrent status: ${status}.\nReply CANCEL if you want to cancel it first, or wait for the restaurant to update you.`;
}

function buildOrderRejectedMessage(note = "") {
  let text = "Sorry, we couldn't accept your order.";
  if (note) {
    text += `\n\nReason: ${note}`;
  }
  text += "\n\nYou can place a new order anytime.";
  return text;
}

function buildOrderCancelledMessage(note = "") {
  let text = "Your order has been cancelled by the restaurant.";
  if (note) {
    text += `\n\nReason: ${note}`;
  }
  text += "\n\nYou can place a new order anytime.";
  return text;
}

function buildOrderReadyMessage({ fulfillmentType }) {
  if (String(fulfillmentType || "").trim().toLowerCase() === "delivery") {
    return "Your order is ready and will be dispatched shortly.";
  }

  return "Your order is ready for pickup. You can place another order anytime.";
}

function buildPaymentConfirmedMessage() {
  return "Payment received successfully. We have started preparing your order.";
}

function buildPaymentRejectedMessage(note = "") {
  let text = "We could not confirm your payment yet.";
  if (note) {
    text += `\n\nReason: ${note}`;
  }
  text += "\n\nPlease try again or send a clearer payment proof.";
  return text;
}

function buildPaymentReviewAcknowledgedMessage() {
  return "Thanks, I have noted your payment message. Please share your order number or the name/number used for the transfer so the restaurant can confirm it. Your payment is not confirmed yet.";
}

function buildPaymentStillUnderReviewMessage() {
  return "Your payment is already under review. If you have not shared it yet, please send your order number or the name/number used for the transfer. We will update you once the restaurant confirms payment.";
}

function buildPaymentReferenceSavedMessage() {
  return "Thanks, I have added those payment details for the restaurant team. They will confirm your payment and update you shortly.";
}

function buildRestaurantOrderAlertMessage(order = {}) {
  const lines = [];
  lines.push(`New Order #${order.id || "-"}`);
  lines.push("");
  lines.push(buildOrderSummaryLineItems(order.matched || []));
  lines.push(`Total = N${Number(order.total || order.amount || 0)}`);
  lines.push("");

  if (String(order.fulfillmentType || "pickup").trim().toLowerCase() === "delivery") {
    lines.push(`Delivery: ${order.deliveryAddress || "Address not provided"}`);
  } else {
    lines.push("Pickup order");
  }

  lines.push("");
  lines.push("Reply:");
  lines.push("1 - Confirm");
  lines.push("2 - Not Available");
  lines.push("3 - Contact Customer");

  return lines.join("\n");
}

function buildRestaurantOrderAlertHandledMessage(order = {}, statusText = "") {
  return `Order #${order.id || "-"} updated.${statusText ? ` ${statusText}` : ""}`;
}

function buildRestaurantContactCustomerMessage(order = {}) {
  const customerPhone = String(order.customerPhone || order.channelCustomerId || "").trim();
  return `Order #${order.id || "-"} is still waiting.\n\nCustomer contact: ${customerPhone || "Not available"}\n\nPlease reach out to the customer directly or continue from the dashboard.`;
}

module.exports = {
  formatMenu,
  buildGuidedMenuList,
  buildGreetingMessage,
  buildStockAvailabilityMessage,
  buildMenuWelcome,
  buildInvalidOrderMessage,
  buildOrderSummaryLineItems,
  buildOrderReceivedMessage,
  buildOrderUpdatedMessage,
  buildConfirmMessage,
  buildManualPaymentInstructionsMessage,
  buildUnavailableItemsMessage,
  buildAwaitingCustomerUpdatePrompt,
  buildAwaitingCustomerEditPrompt,
  buildNoPendingCancelMessage,
  buildSelectedItemPrompt,
  buildDeliveryOrPickupPrompt,
  buildAddressPrompt,
  buildGuidedConfirmPrompt,
  buildGuidedOrderConfirmedMessage,
  buildActiveOrderExistsMessage,
  buildOrderRejectedMessage,
  buildOrderCancelledMessage,
  buildOrderReadyMessage,
  buildPaymentConfirmedMessage,
  buildPaymentRejectedMessage,
  buildPaymentReviewAcknowledgedMessage,
  buildPaymentStillUnderReviewMessage,
  buildPaymentReferenceSavedMessage,
  buildRestaurantOrderAlertMessage,
  buildRestaurantOrderAlertHandledMessage,
  buildRestaurantContactCustomerMessage,
};
