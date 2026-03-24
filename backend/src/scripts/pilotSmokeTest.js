#!/usr/bin/env node

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }

    out[key] = next;
    index += 1;
  }
  return out;
}

function buildHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
}

async function requestJson({ baseUrl, path, method = "GET", apiKey, body }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: buildHeaders(apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let payload = {};

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      payload = { raw };
    }
  }

  if (!response.ok) {
    const message =
      payload.error ||
      payload.message ||
      `Request failed (${method} ${path}) status=${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function toSafeTimeout(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1000, Math.min(120000, Math.round(parsed)));
}

function ensureOrderId(result, fallbackOrders = []) {
  if (result && result.orderId) {
    return result.orderId;
  }

  if (Array.isArray(fallbackOrders) && fallbackOrders.length) {
    return fallbackOrders[0].id || "";
  }

  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = String(args.baseUrl || "http://localhost:3002").replace(/\/+$/, "");
  const restaurantId = String(args.restaurantId || "").trim();
  const apiKey = String(args.apiKey || "").trim();
  const channel = String(args.channel || "whatsapp-web").trim();
  const chatId = String(args.chatId || "2348010000000@c.us").trim();
  const customerPhone = String(args.customerPhone || "+2348010000000").trim();
  const restartTimeoutMs = toSafeTimeout(args.restartTimeoutMs, 45000);
  const cleanupWarnings = [];

  if (!restaurantId || !apiKey) {
    console.error(
      "Usage: node src/scripts/pilotSmokeTest.js --restaurantId <id> --apiKey <key> [--baseUrl <url>] [--chatId <waChatId>] [--customerPhone <phone>] [--restartTimeoutMs <ms>]"
    );
    process.exit(1);
  }

  const prefix = `/api/restaurants/${encodeURIComponent(restaurantId)}`;
  const runId = `pilot-${Date.now()}`;

  function logStep(step, details) {
    if (details) {
      console.log(`${step}:`, details);
      return;
    }
    console.log(step);
  }

  logStep("1) Checking tenant session status");
  const initialSession = await requestJson({
    baseUrl,
    path: `${prefix}/whatsapp/session/status`,
    apiKey,
  });
  logStep("   Session", initialSession.session || {});

  logStep("2) Loading menu for deterministic order text");
  const menuPayload = await requestJson({
    baseUrl,
    path: `${prefix}/menu-items?limit=10`,
    apiKey,
  });
  const availableItems = (menuPayload.items || []).filter(
    (item) => item && item.available !== false
  );
  if (!availableItems.length) {
    throw new Error("No available menu items found. Add at least one available item before smoke test.");
  }

  const primaryItem = availableItems[0];
  const secondaryItem = availableItems[1] || primaryItem;
  const orderText1 = `2 ${primaryItem.name}`;
  const orderText2 = `1 ${secondaryItem.name}`;

  logStep("3) Sending inbound greeting");
  await requestJson({
    baseUrl,
    path: `${prefix}/messages/inbound`,
    method: "POST",
    apiKey,
    body: {
      channel,
      channelCustomerId: chatId,
      customerPhone,
      displayName: "Pilot Test User",
      text: "hello",
      providerMessageId: `${runId}-hello`,
      timestamp: Date.now(),
      type: "chat",
    },
  });

  logStep("4) Sending inbound order #1");
  const inboundOrder1 = await requestJson({
    baseUrl,
    path: `${prefix}/messages/inbound`,
    method: "POST",
    apiKey,
    body: {
      channel,
      channelCustomerId: chatId,
      customerPhone,
      displayName: "Pilot Test User",
      text: orderText1,
      providerMessageId: `${runId}-order-1`,
      timestamp: Date.now(),
      type: "chat",
    },
  });

  const latestAfterOrder1 = await requestJson({
    baseUrl,
    path: `${prefix}/orders?limit=5`,
    apiKey,
  });
  const order1Id = ensureOrderId(inboundOrder1, latestAfterOrder1.orders || []);
  if (!order1Id) {
    throw new Error("Unable to resolve orderId for order #1");
  }
  logStep("   Order #1 ID", order1Id);

  logStep("5) Confirming order #1 (outbound confirmation)");
  await requestJson({
    baseUrl,
    path: `${prefix}/orders/${encodeURIComponent(order1Id)}/confirm`,
    method: "POST",
    apiKey,
    body: {},
  });

  const order1Messages = await requestJson({
    baseUrl,
    path: `${prefix}/orders/${encodeURIComponent(order1Id)}/messages?limit=20`,
    apiKey,
  });
  const hasConfirmMessage = (order1Messages.messages || []).some((entry) => {
    return (
      entry &&
      entry.direction === "outbound" &&
      entry.metadata &&
      entry.metadata.sourceAction === "confirmOrder"
    );
  });
  if (!hasConfirmMessage) {
    throw new Error("Order #1 confirmation message log not found");
  }

  logStep("6) Sending inbound order #2");
  const inboundOrder2 = await requestJson({
    baseUrl,
    path: `${prefix}/messages/inbound`,
    method: "POST",
    apiKey,
    body: {
      channel,
      channelCustomerId: chatId,
      customerPhone,
      displayName: "Pilot Test User",
      text: orderText2,
      providerMessageId: `${runId}-order-2`,
      timestamp: Date.now(),
      type: "chat",
    },
  });

  const latestAfterOrder2 = await requestJson({
    baseUrl,
    path: `${prefix}/orders?limit=5`,
    apiKey,
  });
  const order2Id = ensureOrderId(inboundOrder2, latestAfterOrder2.orders || []);
  if (!order2Id) {
    throw new Error("Unable to resolve orderId for order #2");
  }
  logStep("   Order #2 ID", order2Id);

  logStep("7) Marking unavailable item on order #2");
  await requestJson({
    baseUrl,
    path: `${prefix}/orders/${encodeURIComponent(order2Id)}/unavailable-items`,
    method: "POST",
    apiKey,
    body: {
      items: [secondaryItem.name],
      note: "Pilot smoke unavailable flow",
    },
  });

  const order2Messages = await requestJson({
    baseUrl,
    path: `${prefix}/orders/${encodeURIComponent(order2Id)}/messages?limit=20`,
    apiKey,
  });
  const hasUnavailableMessage = (order2Messages.messages || []).some((entry) => {
    return (
      entry &&
      entry.direction === "outbound" &&
      entry.metadata &&
      entry.metadata.sourceAction === "markItemsUnavailable"
    );
  });
  if (!hasUnavailableMessage) {
    throw new Error("Order #2 unavailable-items outbound message log not found");
  }

  logStep("8) Restarting tenant runtime session");
  try {
    await requestJson({
      baseUrl,
      path: `${prefix}/whatsapp/session/restart`,
      method: "POST",
      apiKey,
      body: {
        reason: "pilot_smoke_test_restart",
        requestTimeoutMs: restartTimeoutMs,
      },
    });

    const finalSession = await requestJson({
      baseUrl,
      path: `${prefix}/whatsapp/session/status`,
      apiKey,
    });
    logStep("   Session after restart", finalSession.session || {});
  } catch (error) {
    const message = String(error && error.message ? error.message : error || "");
    const warning = message.toLowerCase().includes("timed out")
      ? `Tenant restart timed out during cleanup (non-fatal): ${message}`
      : `Tenant restart cleanup failed (non-fatal): ${message}`;
    cleanupWarnings.push(warning);
    console.warn(`Warning: ${warning}`);
    if (error && error.payload) {
      console.warn(JSON.stringify(error.payload, null, 2));
    }
  }

  logStep("9) Capturing pilot ops snapshot");
  const snapshot = await requestJson({
    baseUrl,
    path: `${prefix}/ops/pilot-snapshot`,
    apiKey,
  });
  logStep("   Attention", snapshot.attention || {});

  if (cleanupWarnings.length) {
    console.log("Cleanup warnings:");
    for (const warning of cleanupWarnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log("Pilot smoke test completed successfully.");
}

main().catch((error) => {
  console.error("Pilot smoke test failed.");
  console.error(error.message || error);
  if (error.payload) {
    console.error(JSON.stringify(error.payload, null, 2));
  }
  process.exit(1);
});
