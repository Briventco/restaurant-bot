function formatMenu(menuItems) {
  return (menuItems || [])
    .filter((item) => item.available)
    .map((item) => `- ${item.name} — ₦${item.price}`)
    .join("\n");
}

function buildMenuWelcome(menuItems) {
  return `Welcome 🍽️\n\nHere is our menu:\n${formatMenu(
    menuItems
  )}\n\nReply with what you want, for example:\n2 jollof rice and 1 egg`;
}

function buildInvalidOrderMessage(menuItems) {
  return `I couldn't detect a valid order.\n\nHere is our menu:\n${formatMenu(menuItems)}`;
}

function buildOrderSummaryLineItems(matched) {
  return (matched || [])
    .map((item) => `${item.quantity} x ${item.name} = ₦${item.subtotal}`)
    .join("\n");
}

function buildOrderReceivedMessage({ matched, total, unavailable }) {
  let text = "Thanks - your order has been received.\n\n";
  text += buildOrderSummaryLineItems(matched);
  text += `\n\nTotal: ₦${total}`;
  text += "\nStatus: Waiting for staff confirmation.";

  if (Array.isArray(unavailable) && unavailable.length) {
    text += `\nUnavailable: ${unavailable.join(", ")}`;
  }

  return text;
}

function buildOrderUpdatedMessage({ matched, total, unavailable }) {
  let text = "Your order has been updated.\n\n";
  text += buildOrderSummaryLineItems(matched);
  text += `\n\nTotal: ₦${total}`;
  text += "\nStatus: Waiting for staff confirmation.";

  if (Array.isArray(unavailable) && unavailable.length) {
    text += `\nUnavailable: ${unavailable.join(", ")}`;
  }

  return text;
}

function buildConfirmMessage(total) {
  return `✅ Your order has been confirmed.\n\nTotal: ₦${total}\nStatus: Preparing your order.`;
}

function buildUnavailableItemsMessage(items, note) {
  let message = "Sorry 😔\n\n";
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
  return `Please reply with one option:\n1 - Continue without unavailable items\n2 - Edit order\n3 - Cancel order`;
}

function buildAwaitingCustomerEditPrompt() {
  return `Please send your updated order now.\n\nExample:\n2 jollof rice and 1 beef`;
}

function buildNoPendingCancelMessage() {
  return "You do not have a pending order update to cancel.";
}

module.exports = {
  formatMenu,
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
};
