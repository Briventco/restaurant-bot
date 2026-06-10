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
}) {
  const candidates = buildChannelCustomerIdCandidates(
    customer.channelCustomerId,
    customer.customerPhone
  );

  const [conversationMessages, outboxMessages, routingAudits] = await Promise.all([
    conversationMessageRepo.listMessagesByCustomer({
      restaurantId,
      channel: customer.channel,
      channelCustomerId: customer.channelCustomerId,
      customerPhone: customer.customerPhone,
      limit: 300,
    }),
    outboxService.listOutboxMessages({ restaurantId, limit: 300 }),
    routingAuditRepo
      ? routingAuditRepo.listRecentRoutingAudits({ restaurantId, limit: 300 })
      : Promise.resolve([]),
  ]);

  const items = [];

  for (const message of conversationMessages) {
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

  for (const message of outboxMessages) {
    if (!matchesChannelCustomerId(message.recipient, candidates)) {
      continue;
    }
    if (!String(message.text || "").trim()) {
      continue;
    }

    items.push({
      id: `outbox-${message.id || message.messageId}`,
      direction: "out",
      text: message.text,
      messageType: message.messageType || "text",
      createdAtMs:
        message.sentAtMs || message.createdAtMs || message.updatedAtMs || 0,
      createdAt: message.updatedAt || message.createdAt || null,
      source: "outbox",
    });
  }

  for (const audit of routingAudits) {
    if (!matchesChannelCustomerId(audit.channelCustomerId, candidates)) {
      continue;
    }
    if (!String(audit.textPreview || "").trim()) {
      continue;
    }

    items.push({
      id: `audit-${audit.id}`,
      direction: "in",
      text: audit.textPreview,
      messageType: audit.messageType || "text",
      createdAtMs: toMs(audit.createdAt),
      createdAt: audit.createdAt || null,
      source: "routing_audit",
    });
  }

  const deduped = new Map();
  for (const item of items) {
    const key = `${item.direction}:${item.createdAtMs}:${item.text}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values()).sort(
    (left, right) => Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0)
  );
}

module.exports = {
  buildCustomerActivityList,
  buildCustomerMessageTimeline,
  matchesChannelCustomerId,
};
