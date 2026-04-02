const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAuthenticatingTimedOut,
} = require("../src/runtime/authWatchdogPolicy");

test("times out when authenticating exceeds configured timeout", () => {
  assert.equal(
    isAuthenticatingTimedOut({
      status: "authenticating",
      authenticatedAt: 1000,
      now: 92000,
      timeoutMs: 90000,
    }),
    true
  );
});

test("does not time out before the configured timeout", () => {
  assert.equal(
    isAuthenticatingTimedOut({
      status: "authenticating",
      authenticatedAt: 1000,
      now: 50000,
      timeoutMs: 90000,
    }),
    false
  );
});

test("does not time out for non-authenticating statuses", () => {
  assert.equal(
    isAuthenticatingTimedOut({
      status: "connected",
      authenticatedAt: 1000,
      now: 100000,
      timeoutMs: 90000,
    }),
    false
  );
});
