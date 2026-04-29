require("dotenv").config();

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const OpenAI = require("openai");
const twilio = require("twilio");
const cors = require("cors")({origin: true});
const menu = require("./menu");

admin.initializeApp();
const db = admin.firestore();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
);

function normalizeText(text = "") {
  return String(text).trim().toLowerCase();
}

function formatMenu() {
  return menu
      .filter((item) => item.available)
      .map((item) => `- ${item.name} — ₦${item.price}`)
      .join("\n");
}

async function extractOrder(messageText) {
  const menuText = menu
      .map((item) => `${item.name} (₦${item.price})`)
      .join(", ");

  const response = await openai.responses.create({
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You extract food orders into JSON only. " +
              "Return items mentioned by the user using the menu provided. " +
              "If nothing is ordered, return {\"items\":[]}.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `Menu: ${menuText}\n` +
              `Customer message: ${messageText}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "food_order",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: {type: "string"},
                  quantity: {type: "number"},
                },
                required: ["name", "quantity"],
              },
            },
          },
          required: ["items"],
        },
      },
    },
  });

  if (!response.output_text) {
    throw new Error("OpenAI returned no output_text");
  }

  return JSON.parse(response.output_text);
}

function matchMenuItems(orderItems) {
  const matched = [];
  const unavailable = [];

  for (const orderedItem of orderItems) {
    const found = menu.find((item) => {
      return normalizeText(item.name) ===
        normalizeText(orderedItem.name);
    });

    if (!found) {
      unavailable.push(orderedItem.name);
      continue;
    }

    if (!found.available) {
      unavailable.push(found.name);
      continue;
    }

    const quantity = Number(orderedItem.quantity) || 1;

    matched.push({
      name: found.name,
      price: found.price,
      quantity,
      subtotal: found.price * quantity,
    });
  }

  return {matched, unavailable};
}

function parseFulfillmentType(text = "") {
  const lower = normalizeText(text);

  if (
    lower === "1" ||
    lower.includes("delivery") ||
    lower.includes("deliver")
  ) {
    return "delivery";
  }

  if (
    lower === "2" ||
    lower.includes("pickup") ||
    lower.includes("pick up") ||
    lower.includes("pick-up")
  ) {
    return "pickup";
  }

  return null;
}

function buildConfirmUrl(orderId) {
  return `${process.env.APP_BASE_URL}/confirmOrder?orderId=${orderId}`;
}

function buildIssueUrl(orderId, itemName) {
  const encodedItem = encodeURIComponent(itemName);
  return (
    `${process.env.APP_BASE_URL}` +
    `/markItemUnavailable?orderId=${orderId}` +
    `&item=${encodedItem}`
  );
}

function buildUnavailableActionLines(orderId, matched) {
  const uniqueItemNames = [...new Set(
      matched.map((item) => item.name),
  )];

  return uniqueItemNames.map((itemName) => {
    const issueUrl = buildIssueUrl(orderId, itemName);
    return `${itemName.toUpperCase()} UNAVAILABLE: ${issueUrl}`;
  });
}

async function sendStaffNotification(message) {
  if (
    !process.env.TWILIO_WHATSAPP_NUMBER ||
    !process.env.STAFF_WHATSAPP_NUMBER
  ) {
    logger.warn("Missing WhatsApp env vars for staff notification");
    return;
  }

  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: process.env.STAFF_WHATSAPP_NUMBER,
    body: message,
  });
}

async function sendCustomerMessage(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
}

function renderHiddenInputs(hiddenInputs) {
  return hiddenInputs
      .map((input) => {
        return (
          `<input type="hidden" ` +
          `name="${input.name}" ` +
          `value="${input.value}" />`
        );
      })
      .join("\n");
}

function renderActionPage(
    title,
    message,
    buttonText,
    hiddenInputs,
    color,
) {
  const hiddenHtml = renderHiddenInputs(hiddenInputs);

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        />
        <title>${title}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 480px;
            margin: 40px auto;
            padding: 20px;
            line-height: 1.5;
          }
          h2 {
            margin-bottom: 8px;
          }
          p {
            margin-bottom: 20px;
          }
          button {
            background: ${color};
            color: white;
            border: none;
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <h2>${title}</h2>
        <p>${message}</p>
        <form method="POST">
          ${hiddenHtml}
          <button type="submit">${buttonText}</button>
        </form>
      </body>
    </html>
  `;
}

async function getOrderOrThrow(orderId) {
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    throw new Error("Order not found");
  }

  return {
    orderRef,
    order: orderSnap.data(),
  };
}

function wantsJson(req) {
  return Boolean(
      req.headers.accept &&
      req.headers.accept.includes("application/json"),
  );
}

function serializeOrder(doc) {
  const data = doc.data();

  return {
    id: doc.id,
    ...data,
    createdAt:
      data.createdAt && data.createdAt.toDate ?
        data.createdAt.toDate().toISOString() :
        null,
    confirmedAt:
      data.confirmedAt && data.confirmedAt.toDate ?
        data.confirmedAt.toDate().toISOString() :
        null,
    updatedAt:
      data.updatedAt && data.updatedAt.toDate ?
        data.updatedAt.toDate().toISOString() :
        null,
  };
}

function buildStaffSummary(orderId, orderData, title = "NEW ORDER") {
  const confirmUrl = buildConfirmUrl(orderId);
  const unavailableActionLines = buildUnavailableActionLines(
      orderId,
      orderData.matched || [],
  );

  return [
    "[STAFF ALERT]",
    title,
    `Customer: ${orderData.from}`,
    "",
    ...(orderData.matched || []).map((item) => {
      return `${item.quantity} x ${item.name} = ₦${item.subtotal}`;
    }),
    "",
    `Total: ₦${orderData.total}`,
    (orderData.unavailable || []).length ?
      `Unavailable: ${orderData.unavailable.join(", ")}` :
      "",
    `Order ID: ${orderId}`,
    "",
    `CONFIRM ORDER: ${confirmUrl}`,
    ...unavailableActionLines,
  ].filter(Boolean).join("\n");
}

async function notifyStaffAboutOrder(orderId, orderData, title) {
  const staffSummary = buildStaffSummary(orderId, orderData, title);
  await sendStaffNotification(staffSummary);
}

async function findActiveOrderByCustomer(from) {
  const activeStatuses = [
    "pending_confirmation",
    "awaiting_fulfillment_type",
    "awaiting_customer_confirmation",
    "awaiting_customer_update",
    "awaiting_customer_edit",
    "confirmed",
    "preparing",
  ];

  const snapshot = await db
      .collection("orders")
      .where("from", "==", from)
      .where("status", "in", activeStatuses)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];

  return {
    id: doc.id,
    ref: doc.ref,
    data: doc.data(),
  };
}

function renderOrderSummary(order) {
  let summary = (order.matched || []).map((item) => {
    return `${item.quantity} x ${item.name} = â‚¦${item.subtotal}`;
  }).join("\n");

  summary += `\n\nTotal: â‚¦${order.total}`;

  if (order.fulfillmentType) {
    summary += `\nFulfillment: ${order.fulfillmentType}`;
  }

  return summary;
}

async function handleAwaitingFulfillmentType(activeOrder, incomingMessage) {
  const fulfillmentType = parseFulfillmentType(incomingMessage);

  if (!fulfillmentType) {
    return {
      handled: true,
      reply: `Please choose one option:
1 - Delivery
2 - Pickup`,
    };
  }

  await activeOrder.ref.update({
    fulfillmentType,
    status: "awaiting_customer_confirmation",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const orderWithFulfillment = {
    ...activeOrder.data,
    fulfillmentType,
  };

  let reply = "Great. Please confirm your order:\n\n";
  reply += renderOrderSummary(orderWithFulfillment);
  reply += "\n\nReply with CONFIRM to place this order, or CANCEL to stop.";

  return {
    handled: true,
    reply,
  };
}

async function handleAwaitingCustomerConfirmation(activeOrder, incomingMessage) {
  const lower = normalizeText(incomingMessage);

  if (lower === "cancel") {
    await activeOrder.ref.update({
      status: "cancelled",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      handled: true,
      reply: "Your order has been cancelled.",
    };
  }

  if (lower !== "confirm") {
    return {
      handled: true,
      reply: "Reply with CONFIRM to place your order, or CANCEL to stop.",
    };
  }

  await activeOrder.ref.update({
    status: "pending_confirmation",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const orderData = {
    ...activeOrder.data,
    status: "pending_confirmation",
  };

  try {
    await notifyStaffAboutOrder(activeOrder.id, orderData, "NEW ORDER");
  } catch (staffError) {
    logger.error("Failed to send staff notification", {
      message: staffError.message,
      stack: staffError.stack,
    });
  }

  let reply = "Thanks - your order has been received.\n\n";
  reply += renderOrderSummary(orderData);
  reply += "\nStatus: Waiting for staff confirmation.";

  if ((orderData.unavailable || []).length) {
    reply += `\nUnavailable: ${(orderData.unavailable || []).join(", ")}`;
  }

  return {
    handled: true,
    reply,
  };
}

async function handleAwaitingCustomerUpdate(activeOrder, incomingMessage) {
  const lower = normalizeText(incomingMessage);
  const orderRef = activeOrder.ref;
  const order = activeOrder.data;
  const unavailableItems = order.unavailableItems || [];

  if (lower === "1" || lower === "continue") {
    const filteredMatched = (order.matched || []).filter((item) => {
      return !unavailableItems.includes(item.name);
    });

    const total = filteredMatched.reduce((sum, item) => {
      return sum + item.subtotal;
    }, 0);

    await orderRef.update({
      matched: filteredMatched,
      total,
      status: "pending_confirmation",
      unavailableItems: [],
      issueType: admin.firestore.FieldValue.delete(),
      staffNote: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const updatedOrder = {
      ...order,
      matched: filteredMatched,
      total,
      status: "pending_confirmation",
      unavailableItems: [],
      issueType: undefined,
      staffNote: undefined,
    };

    await notifyStaffAboutOrder(
        activeOrder.id,
        updatedOrder,
        "UPDATED ORDER",
    );

    let reply = "Okay — your order has been updated.\n\n";
    reply += filteredMatched.map((item) => {
      return `${item.quantity} x ${item.name} = ₦${item.subtotal}`;
    }).join("\n");
    reply += `\n\nTotal: ₦${total}`;
    reply += "\nStatus: Waiting for staff confirmation.";

    return {
      handled: true,
      reply,
    };
  }

  if (lower === "2" || lower === "edit" || lower === "edit order") {
    await orderRef.update({
      status: "awaiting_customer_edit",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      handled: true,
      reply: `Please send your updated order now.

Example:
2 jollof rice and 1 beef`,
    };
  }

  if (lower === "3" || lower === "cancel") {
    await orderRef.update({
      status: "cancelled",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      handled: true,
      reply: "Your order has been cancelled.",
    };
  }

  return {
    handled: true,
    reply: `Please reply with one option:
1 - Continue without unavailable items
2 - Edit order
3 - Cancel order`,
  };
}

async function handleAwaitingCustomerEdit(activeOrder, incomingMessage) {
  const extracted = await extractOrder(incomingMessage);
  const orderItems = extracted.items || [];
  const {matched, unavailable} = matchMenuItems(orderItems);

  if (!matched.length) {
    return {
      handled: true,
      reply: `I couldn't detect a valid updated order.

Please send something like:
2 jollof rice and 1 beef`,
    };
  }

  const total = matched.reduce((sum, item) => {
    return sum + item.subtotal;
  }, 0);

  await activeOrder.ref.update({
    rawMessage: incomingMessage,
    matched,
    unavailable,
    total,
    status: "pending_confirmation",
    issueType: admin.firestore.FieldValue.delete(),
    unavailableItems: [],
    unavailableItem: admin.firestore.FieldValue.delete(),
    staffNote: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const updatedOrder = {
    ...activeOrder.data,
    rawMessage: incomingMessage,
    matched,
    unavailable,
    total,
    status: "pending_confirmation",
  };

  await notifyStaffAboutOrder(
      activeOrder.id,
      updatedOrder,
      "UPDATED ORDER",
  );

  let reply = "Your order has been updated.\n\n";
  reply += matched.map((item) => {
    return `${item.quantity} x ${item.name} = ₦${item.subtotal}`;
  }).join("\n");
  reply += `\n\nTotal: ₦${total}`;
  reply += "\nStatus: Waiting for staff confirmation.";

  if (unavailable.length) {
    reply += `\nUnavailable: ${unavailable.join(", ")}`;
  }

  return {
    handled: true,
    reply,
  };
}

exports.whatsappWebhook = onRequest(async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingMessage = req.body && req.body.Body ?
      req.body.Body :
      "";

    const from = req.body && req.body.From ?
      req.body.From :
      "";

    logger.info("Incoming WhatsApp message", {
      from,
      incomingMessage,
    });

    const lower = normalizeText(incomingMessage);

    if (
      !incomingMessage ||
      lower === "hi" ||
      lower === "hello" ||
      lower === "menu"
    ) {
      twiml.message(`Welcome 🍽️

Here is our menu:
${formatMenu()}

Reply with what you want, for example:
2 jollof rice and 1 egg`);
      res.type("text/xml").send(twiml.toString());
      return;
    }

    const activeOrder = await findActiveOrderByCustomer(from);

    if (activeOrder &&
      activeOrder.data.status === "awaiting_fulfillment_type") {
      const result = await handleAwaitingFulfillmentType(
          activeOrder,
          incomingMessage,
      );

      if (result.handled) {
        twiml.message(result.reply);
        res.type("text/xml").send(twiml.toString());
        return;
      }
    }

    if (activeOrder &&
      activeOrder.data.status === "awaiting_customer_confirmation") {
      const result = await handleAwaitingCustomerConfirmation(
          activeOrder,
          incomingMessage,
      );

      if (result.handled) {
        twiml.message(result.reply);
        res.type("text/xml").send(twiml.toString());
        return;
      }
    }

    if (activeOrder &&
      activeOrder.data.status === "awaiting_customer_update") {
      const result = await handleAwaitingCustomerUpdate(
          activeOrder,
          incomingMessage,
      );

      if (result.handled) {
        twiml.message(result.reply);
        res.type("text/xml").send(twiml.toString());
        return;
      }
    }

    if (activeOrder &&
      activeOrder.data.status === "awaiting_customer_edit") {
      const result = await handleAwaitingCustomerEdit(
          activeOrder,
          incomingMessage,
      );

      if (result.handled) {
        twiml.message(result.reply);
        res.type("text/xml").send(twiml.toString());
        return;
      }
    }

    if (lower === "cancel") {
      twiml.message("You do not have a pending order update to cancel.");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    const extracted = await extractOrder(incomingMessage);
    const orderItems = extracted.items || [];
    const {matched, unavailable} = matchMenuItems(orderItems);

    if (!matched.length) {
      twiml.message(`I couldn't detect a valid order.

Here is our menu:
${formatMenu()}`);
      res.type("text/xml").send(twiml.toString());
      return;
    }

    const total = matched.reduce((sum, item) => {
      return sum + item.subtotal;
    }, 0);

    const orderDoc = await db.collection("orders").add({
      from,
      rawMessage: incomingMessage,
      matched,
      unavailable,
      total,
      status: "awaiting_fulfillment_type",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    let customerReply = "Nice choice. Do you want delivery or pickup?\n";
    customerReply += "1 - Delivery\n2 - Pickup\n\n";
    customerReply += `Order #${orderDoc.id}\n`;
    customerReply += renderOrderSummary({matched, total});

    if (unavailable.length) {
      customerReply += `\nUnavailable: ${unavailable.join(", ")}`;
    }

    twiml.message(customerReply);
    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    logger.error("Webhook error", {
      message: error.message,
      stack: error.stack,
    });

    twiml.message(`Sorry, something went wrong while processing your order.

Error: ${error.message}`);
    res.type("text/xml").send(twiml.toString());
  }
});

exports.confirmOrder = onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const orderId = req.query.orderId ||
        (req.body && req.body.orderId);

      if (!orderId) {
        if (wantsJson(req)) {
          res.status(400).json({error: "Missing orderId"});
          return;
        }

        res.status(400).send("Missing orderId");
        return;
      }

      if (req.method === "GET") {
        res.status(200).send(
            renderActionPage(
                "Confirm Order",
                "Are you sure you want to confirm this order?",
                "Confirm Order",
                [{name: "orderId", value: orderId}],
                "#16a34a",
            ),
        );
        return;
      }

      const {orderRef, order} = await getOrderOrThrow(orderId);

      if (order.status === "confirmed") {
        if (wantsJson(req)) {
          res.status(200).json({
            success: true,
            message: "Order already confirmed",
          });
          return;
        }

        res.status(200).send("Order already confirmed");
        return;
      }

      await orderRef.update({
        status: "confirmed",
        confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await sendCustomerMessage(
          order.from,
          `✅ Your order has been confirmed.

Total: ₦${order.total}
Status: Preparing your order.`,
      );

      if (wantsJson(req)) {
        res.status(200).json({
          success: true,
          message: "Order confirmed and customer notified",
        });
        return;
      }

      res.status(200).send("Order confirmed and customer notified");
    } catch (error) {
      logger.error("Confirm order error", {
        message: error.message,
        stack: error.stack,
      });

      if (wantsJson(req)) {
        res.status(500).json({error: error.message});
        return;
      }

      res.status(500).send(
          `Failed to confirm order: ${error.message}`,
      );
    }
  });
});

exports.markItemUnavailable = onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const orderId = req.query.orderId ||
        (req.body && req.body.orderId);

      const itemName = req.query.item ||
        (req.body && req.body.item);

      if (!orderId || !itemName) {
        if (wantsJson(req)) {
          res.status(400).json({
            error: "Missing orderId or item",
          });
          return;
        }

        res.status(400).send("Missing orderId or item");
        return;
      }

      if (req.method === "GET") {
        const message =
          `Are you sure you want to mark "` +
          `${itemName}" as unavailable for this order?`;

        res.status(200).send(
            renderActionPage(
                "Item Unavailable",
                message,
                "Send Update to Customer",
                [
                  {name: "orderId", value: orderId},
                  {name: "item", value: itemName},
                ],
                "#dc2626",
            ),
        );
        return;
      }

      const {orderRef, order} = await getOrderOrThrow(orderId);

      await orderRef.update({
        status: "awaiting_customer_update",
        issueType: "item_unavailable",
        unavailableItem: itemName,
        unavailableItems: [itemName],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await sendCustomerMessage(
          order.from,
          `Sorry 😔

${itemName} is currently unavailable.

Reply with one option:
1 - Continue without unavailable items
2 - Edit order
3 - Cancel order`,
      );

      if (wantsJson(req)) {
        res.status(200).json({
          success: true,
          message: `${itemName} marked unavailable`,
        });
        return;
      }

      res.status(200).send(
          `Marked ${itemName} as unavailable and customer notified`,
      );
    } catch (error) {
      logger.error("Mark item unavailable error", {
        message: error.message,
        stack: error.stack,
      });

      if (wantsJson(req)) {
        res.status(500).json({error: error.message});
        return;
      }

      res.status(500).send(
          `Failed to mark item unavailable: ${error.message}`,
      );
    }
  });
});

exports.getOrders = onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const snapshot = await db
          .collection("orders")
          .orderBy("createdAt", "desc")
          .get();

      const orders = snapshot.docs.map((doc) => serializeOrder(doc));

      res.status(200).json({orders});
    } catch (error) {
      logger.error("Get orders error", {
        message: error.message,
        stack: error.stack,
      });

      res.status(500).json({
        error: error.message,
      });
    }
  });
});

exports.markItemsUnavailable = onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const orderId = req.body && req.body.orderId;
      const items = req.body && req.body.items;
      const note = req.body && req.body.note ?
        req.body.note.trim() :
        "";

      if (!orderId || !Array.isArray(items) || !items.length) {
        res.status(400).json({
          error: "Missing orderId or items",
        });
        return;
      }

      const {orderRef, order} = await getOrderOrThrow(orderId);

      await orderRef.update({
        status: "awaiting_customer_update",
        issueType: "items_unavailable",
        unavailableItems: items,
        staffNote: note,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      let message = "Sorry 😔\n\n";
      message += "The following items are currently unavailable:\n";
      message += items.map((item) => `- ${item}`).join("\n");

      if (note) {
        message += `\n\n${note}`;
      }

      message += "\n\nReply with one option:";
      message += "\n1 - Continue without unavailable items";
      message += "\n2 - Edit order";
      message += "\n3 - Cancel order";

      await sendCustomerMessage(order.from, message);

      res.status(200).json({
        success: true,
        message: "Customer notified successfully",
      });
    } catch (error) {
      logger.error("Mark items unavailable error", {
        message: error.message,
        stack: error.stack,
      });

      res.status(500).json({
        error: error.message,
      });
    }
  });
});
