const test = require("node:test");
const assert = require("node:assert/strict");

const {
  requiresManualReauthentication,
} = require("../src/runtime/sessionFailurePolicy");

test("requires manual reauthentication for logout-like disconnect reasons", () => {
  assert.equal(requiresManualReauthentication("LOGOUT"), true);
  assert.equal(requiresManualReauthentication("Logged out from WhatsApp Web"), true);
  assert.equal(requiresManualReauthentication("auth_failure"), true);
  assert.equal(requiresManualReauthentication("Authentication failure"), true);
});

test("does not require manual reauthentication for transient disconnect reasons", () => {
  assert.equal(requiresManualReauthentication("NAVIGATION"), false);
  assert.equal(requiresManualReauthentication("Protocol error"), false);
  assert.equal(requiresManualReauthentication(""), false);
});
