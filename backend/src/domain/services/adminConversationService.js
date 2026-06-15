const {
  buildChannelCustomerIdCandidates,
} = require("../../repositories/conversationMessageRepo");
const { customerDocId } = require("../../repositories/customerRepo");

function toMs(value) {
  if (!value) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function matchesChannelCustomerId(value, candidates) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  if (candidates.includes(normalized)) {
    return true;
  }

  const base = normalized.split("@")[0].replace(/\D/g, "");
  if (!base) {
    return false;
  }

  return candidates.some(
    (candidate) => candidate.split("@")[0].replace(/\D/g, "") === base
  );
}

function buildCustomerLabel(customer = {}) {
  const displayName = String(customer.displayName || "").trim();
  if (displayName) {
    return displayName;
  }

  const phone = String(customer.customerPhone || "").trim();
  if (phone) {
    return phone;
  }

  const customerId = String(customer.id || "").trim();
  if (!customerId) {
    return "Customer";
  }

  const shortNumber = parseInt(customerId.slice(-6), 16);
  const safeNumber = Number.isFinite(shortNumber) ? Math.abs(shortNumber % 10000) : 0;

  return `Customer #${String(safeNumber).padStart(4, "0")}`;
}

async function buildCustomerActivityList({
  restaurantId,
  customerRepo,
  orderRepo,
  limit = 500,
}) {
  const effectiveLimit = Math.max(1, Math.min(500, Number(limit) || 500));

  const [customers, orders] = await Promise.all([
    customerRepo.listCustomers({ restaurantId, limit: effectiveLimit }),
    orderRepo.listOrders(restaurantId, { limit: Math.min(300, effectiveLimit) }),
  ]);

  const merged = new Map();

  for (const customer of customers) {
    const lastActivityAt =
      customer.lastMessageAt || customer.updatedAt || customer.createdAt || null;

    merged.set(customer.id, {
      ...customer,
      lastActivityAt,
      lastActivityMs: toMs(lastActivityAt),
      orderCount: 0,
    });
  }

  for (const order of orders) {
    const id = customerDocId(order.channel, order.channelCustomerId);
    const orderAt = order.updatedAt || order.createdAt || null;
    const orderMs = toMs(orderAt);
    const existing = merged.get(id);

    if (!existing) {
      merged.set(id, {
        id,
        channel: order.channel || "",
        channelCustomerId: order.channelCustomerId || "",
        customerPhone: order.customerPhone || "",
        displayName: "",
        updatedAt: orderAt,
        createdAt: orderAt,
        lastMessageAt: null,
        lastActivityAt: orderAt,
        lastActivityMs: orderMs,
        orderCount: 1,
      });
      continue;
    }

    existing.orderCount = Number(existing.orderCount || 0) + 1;
    if (orderMs > Number(existing.lastActivityMs || 0)) {
      existing.lastActivityAt = orderAt;
      existing.lastActivityMs = orderMs;
    }
    if (!existing.customerPhone && order.customerPhone) {
      existing.customerPhone = order.customerPhone;
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => Number(right.lastActivityMs || 0) - Number(left.lastActivityMs || 0))
    .slice(0, effectiveLimit);
}

async function buildCustomerMessageTimeline({
  restaurantId,
  customer,
  conversationMessageRepo,
  outboxService,
  routingAuditRepo,
  limit = 50,
  beforeMs = 0,
}) {
  const candidates = buildChannelCustomerIdCandidates(
    customer.channelCustomerId,
    customer.customerPhone
  );
  const effectiveLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const effectiveBeforeMs = Number(beforeMs) > 0 ? Number(beforeMs) : 0;

  const [conversationMessages, outboxMessages, routingAudits] = await Promise.all([
    conversationMessageRepo.listMessagesByCustomer({
      restaurantId,
      channel: customer.channel,
      channelCustomerId: customer.channelCustomerId,
      customerPhone: customer.customerPhone,
      limit: effectiveLimit * 3,
      beforeMs: effectiveBeforeMs,
    }),
    outboxService.listOutboxMessages({ restaurantId, limit: effectiveLimit * 4 }),
    routingAuditRepo
      ? routingAuditRepo.listRecentRoutingAudits({ restaurantId, limit: effectiveLimit * 2 })
      : Promise.resolve([]),
  ]);
  const hasConversationMessages = conversationMessages.length > 0;

  const items = [];

  for (const message of conversationMessages) {
    if (effectiveBeforeMs > 0 && Number(message.createdAtMs || 0) >= effectiveBeforeMs) {
      continue;
    }
    items.push({
      id: message.id,
      direction: message.direction,
      text: message.text,
      messageType: message.messageType || "text",
      createdAtMs: message.createdAtMs || 0,
      createdAt: message.createdAt || null,
      source: "conversation",
    });
  }

  if (!hasConversationMessages) {
    for (const message of outboxMessages) {
      if (!matchesChannelCustomerId(message.recipient, candidates)) {
        continue;
      }
      if (!String(message.text || "").trim()) {
        continue;
      }

      const createdAtMs =
        message.sentAtMs || message.createdAtMs || message.updatedAtMs || 0;
      if (effectiveBeforeMs > 0 && Number(createdAtMs || 0) >= effectiveBeforeMs) {
        continue;
      }

      items.push({
        id: `outbox-${message.id || message.messageId}`,
        direction: "out",
        text: message.text,
        messageType: message.messageType || "text",
        createdAtMs,
        createdAt: message.updatedAt || message.createdAt || null,
        source: "outbox",
      });
    }
  }

  if (!hasConversationMessages && !outboxMessages.length) {
    for (const audit of routingAudits) {
      if (!matchesChannelCustomerId(audit.channelCustomerId, candidates)) {
        continue;
      }
      if (!String(audit.textPreview || "").trim()) {
        continue;
      }

      const createdAtMs = toMs(audit.createdAt);
      if (effectiveBeforeMs > 0 && createdAtMs >= effectiveBeforeMs) {
        continue;
      }

      items.push({
        id: `audit-${audit.id}`,
        direction: "in",
        text: audit.textPreview,
        messageType: audit.messageType || "text",
        createdAtMs,
        createdAt: audit.createdAt || null,
        source: "routing_audit",
      });
    }
  }

  const deduped = new Map();
  for (const item of items) {
    const normalizedText = String(item.text || "").trim().toLowerCase();
    const key = `${item.direction}:${item.createdAtMs}:${normalizedText}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  const ordered = Array.from(deduped.values()).sort(
    (left, right) =>
      Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0) ||
      (left.direction === "in" ? -1 : 1) - (right.direction === "in" ? -1 : 1) ||
      String(left.id || "").localeCompare(String(right.id || ""))
  );

  const page = ordered.slice(Math.max(0, ordered.length - effectiveLimit));
  const oldest = page.length ? Number(page[0].createdAtMs || 0) : 0;

  return {
    items: page,
    hasMore: ordered.length > page.length,
    nextBeforeMs: oldest || 0,
  };
}

module.exports = {
  buildCustomerActivityList,
  buildCustomerMessageTimeline,
  buildCustomerLabel,
  matchesChannelCustomerId,
};
