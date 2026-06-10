const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildChannelCustomerIdCandidates,
} = require("../src/repositories/conversationMessageRepo");

test("buildChannelCustomerIdCandidates includes lid and c.us variants", () => {
  const candidates = buildChannelCustomerIdCandidates("249512434073771@lid", "+2348050000000");

  assert.ok(candidates.includes("249512434073771@lid"));
  assert.ok(candidates.includes("249512434073771@c.us"));
  assert.ok(candidates.includes("249512434073771"));
});
