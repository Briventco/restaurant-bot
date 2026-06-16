const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const {
  resolveWhatsappSessionDataPath,
  cleanAllWhatsappSessionLocks,
  clearRuntimeProcessLocks,
} = require("../src/utils/chromiumLockCleanup");

function main() {
  console.log("[lock-cleanup] Starting Chromium lock file cleanup...");

  const sessionDataPath = resolveWhatsappSessionDataPath(path.join(__dirname, ".."));
  const legacyAuthDir = path.join(__dirname, "..", ".wwebjs_auth");
  const legacyCacheDir = path.join(__dirname, "..", ".wwebjs_cache");

  console.log(`[lock-cleanup] Session data path: ${sessionDataPath}`);

  const sessionLocksRemoved = cleanAllWhatsappSessionLocks(sessionDataPath);
  const runtimeLocksRemoved = clearRuntimeProcessLocks(sessionDataPath);
  const legacyAuthRemoved = cleanAllWhatsappSessionLocks(legacyAuthDir);
  const legacyCacheRemoved = cleanAllWhatsappSessionLocks(legacyCacheDir);

  const totalCleaned =
    sessionLocksRemoved + runtimeLocksRemoved + legacyAuthRemoved + legacyCacheRemoved;

  console.log(
    `[lock-cleanup] Cleanup complete. Removed ${totalCleaned} lock file(s) ` +
      `(session=${sessionLocksRemoved}, runtime=${runtimeLocksRemoved}, legacyAuth=${legacyAuthRemoved}, legacyCache=${legacyCacheRemoved}).`
  );
}

main();
