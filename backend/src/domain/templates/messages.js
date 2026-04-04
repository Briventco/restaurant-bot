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

function buildInvalidOrderMessage(menuItems) {
  return `I couldn't detect a valid order.\n\nHere is our menu:\n${formatMenu(menuItems)}`;
}

function buildOrderSummaryLineItems(matched) {
  return (matched || [])
    .map((item) => `${item.quantity} x ${item.name} = N${item.subtotal}`)
    .join("\n");
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

function buildSelectedItemPrompt(item) {
  return `You selected ${item.name} - N${item.price}\n\nHow many portions?`;
}

function buildDeliveryOrPickupPrompt({ itemName, quantity, total }) {
  return `Order Summary:\n${quantity} x ${itemName} = N${total}\n\nDelivery or Pickup?\nReply D or P`;
}

function buildAddressPrompt() {
  return "Please send your delivery address.";
}

function buildGuidedConfirmPrompt({ itemName, quantity, total, fulfillmentType, address }) {
  let text = "Confirm order?\n\n";
  text += `${quantity} x ${itemName} = N${total}`;
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

function buildOrderRejectedMessage(note = "") {
  let text = "Your order could not be accepted.";
  if (note) {
    text += `\n\nReason: ${note}`;
  }
  return text;
}

function buildOrderReadyMessage({ fulfillmentType }) {
  if (String(fulfillmentType || "").trim().toLowerCase() === "delivery") {
    return "Your order is ready and will be dispatched shortly.";
  }

  return "Your order is ready for pickup.";
}

module.exports = {
  formatMenu,
  buildGuidedMenuList,
  buildMenuWelcome,
  buildInvalidOrderMessage,
  buildOrderSummaryLineItems,
  buildOrderReceivedMessage,
  buildOrderUpdatedMessage,
  buildConfirmMessage,
  buildUnavailableItemsMessage,
  buildAwaitingCustomerUpdatePrompt,
  buildAwaitingCustomerEditPrompt,
  buildNoPendingCancelMessage,
  buildSelectedItemPrompt,
  buildDeliveryOrPickupPrompt,
  buildAddressPrompt,
  buildGuidedConfirmPrompt,
  buildGuidedOrderConfirmedMessage,
  buildOrderRejectedMessage,
  buildOrderReadyMessage,
};
