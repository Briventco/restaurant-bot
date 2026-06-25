const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeOutboundRecipient,
  buildRecipientCandidates,
  isStaleWhatsappClientError,
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

test("buildRecipientCandidates prefers @c.us before @lid for LID contacts", () => {
  const candidates = buildRecipientCandidates("249512434073771@lid");
  assert.ok(candidates.length >= 2);
  assert.equal(candidates[0], "249512434073771@c.us");
  assert.ok(candidates.includes("249512434073771@lid"));
});

test("isStaleWhatsappClientError detects broken whatsapp-web.js client state", () => {
  assert.equal(
    isStaleWhatsappClientError(
      new Error("Cannot read properties of undefined (reading 'getChat')")
    ),
    true
  );
  assert.equal(isStaleWhatsappClientError(new Error("No LID for user")), false);
});
