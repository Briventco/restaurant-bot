const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveWhatsappSessionDataPath,
  cleanAllWhatsappSessionLocks,
  clearRuntimeProcessLocks,
} = require("../src/utils/chromiumLockCleanup");

test("resolveWhatsappSessionDataPath prefers WHATSAPP_SESSION_DATA_PATH", () => {
  const previous = process.env.WHATSAPP_SESSION_DATA_PATH;
  process.env.WHATSAPP_SESSION_DATA_PATH = "/var/data/wwebjs_auth";
  try {
    assert.equal(resolveWhatsappSessionDataPath("/tmp"), "/var/data/wwebjs_auth");
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_SESSION_DATA_PATH;
    } else {
      process.env.WHATSAPP_SESSION_DATA_PATH = previous;
    }
  }
});

test("cleanAllWhatsappSessionLocks removes Chromium singleton files from session dirs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wwebjs-auth-test-"));
  const sessionDir = path.join(root, "session-restaurant_lead_mall");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "SingletonLock"), "stale");
  fs.writeFileSync(path.join(sessionDir, "SingletonCookie"), "stale");
  fs.writeFileSync(
    path.join(sessionDir, ".org.chromium.Chromium.test"),
    "stale"
  );
  fs.writeFileSync(path.join(sessionDir, ".runtime.lock"), "{}");

  const removed = cleanAllWhatsappSessionLocks(root);
  const runtimeRemoved = clearRuntimeProcessLocks(root);

  assert.equal(removed, 3);
  assert.equal(runtimeRemoved, 1);
  assert.equal(fs.existsSync(path.join(sessionDir, "SingletonLock")), false);
  assert.equal(fs.existsSync(path.join(sessionDir, ".runtime.lock")), false);

  fs.rmSync(root, { recursive: true, force: true });
});
