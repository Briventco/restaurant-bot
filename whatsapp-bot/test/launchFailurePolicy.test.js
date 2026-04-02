const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyLaunchFailure,
} = require("../src/runtime/launchFailurePolicy");

test("classifies browser session lock failures explicitly", () => {
  const result = classifyLaunchFailure({
    message:
      "The browser is already running for C:\\temp\\session. Use a different userDataDir or stop the running browser first.",
  });

  assert.equal(result.code, "SESSION_CONFLICT");
  assert.equal(result.reconnectReason, "session_conflict");
});

test("falls back to generic startup failure classification", () => {
  const result = classifyLaunchFailure({
    code: "EPERM",
    message: "spawn EPERM",
  });

  assert.equal(result.code, "EPERM");
  assert.equal(result.reconnectReason, "start_failed");
});
