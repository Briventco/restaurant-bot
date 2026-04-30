const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeOutboundRecipient,
} = require("../src/channels/whatsapp-web/whatsappClientRegistry");

test("normalizeOutboundRecipient keeps existing WhatsApp IDs untouched", () => {
  assert.equal(
    normalizeOutboundRecipient("249512434073771@lid"),
    "249512434073771@lid"
  );
  assert.equal(
    normalizeOutboundRecipient("2349130428547@c.us"),
    "2349130428547@c.us"
  );
});

test("normalizeOutboundRecipient converts phone numbers to c.us format", () => {
  assert.equal(
    normalizeOutboundRecipient("+234 913 042 8547"),
    "2349130428547@c.us"
  );
  assert.equal(
    normalizeOutboundRecipient("09130428547"),
    "09130428547@c.us"
  );
});
