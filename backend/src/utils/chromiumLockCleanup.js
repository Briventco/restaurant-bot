const fs = require("fs");
const path = require("path");

const CHROMIUM_LOCK_NAMES = new Set([
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
]);

function resolveWhatsappSessionDataPath(cwd = process.cwd()) {
  const explicit = String(process.env.WHATSAPP_SESSION_DATA_PATH || "").trim();
  if (explicit) {
    return explicit;
  }

  const renderDiskPath = String(process.env.RENDER_DISK_PATH || "").trim();
  if (renderDiskPath) {
    return path.join(renderDiskPath, "wwebjs_auth");
  }

  return path.join(cwd, ".wwebjs_auth");
}

function isChromiumLockEntry(name) {
  return CHROMIUM_LOCK_NAMES.has(name) || name.startsWith(".org.chromium.Chromium.");
}

function removePathIfExists(targetPath) {
  try {
    fs.rmSync(targetPath, { force: true, recursive: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function cleanChromiumLocksInDirectory(directory, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 6;
  const logPrefix = String(options.logPrefix || "[lock-cleanup]").trim();
  const onRemoved = typeof options.onRemoved === "function" ? options.onRemoved : null;

  function walk(currentDir, depth) {
    if (depth < 0 || !fs.existsSync(currentDir)) {
      return 0;
    }

    let removed = 0;
    let entries = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_error) {
      return 0;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (isChromiumLockEntry(entry.name)) {
        if (removePathIfExists(entryPath)) {
          removed += 1;
          if (onRemoved) {
            onRemoved(entryPath);
          } else {
            console.log(`${logPrefix} Removed: ${entryPath}`);
          }
        }
        continue;
      }

      if (entry.isDirectory() && depth > 0) {
        removed += walk(entryPath, depth - 1);
      }
    }

    return removed;
  }

  return walk(directory, maxDepth);
}

function cleanRestaurantSessionLocks(sessionDataPath, restaurantId, sanitizeClientId) {
  const safeId = sanitizeClientId(restaurantId);
  const clientDataPath = path.join(sessionDataPath, `session-restaurant_${safeId}`);
  return cleanChromiumLocksInDirectory(clientDataPath, {
    maxDepth: 4,
    logPrefix: "[lock-cleanup]",
  });
}

function cleanAllWhatsappSessionLocks(sessionDataPath, options = {}) {
  if (!sessionDataPath || !fs.existsSync(sessionDataPath)) {
    return 0;
  }

  let removed = cleanChromiumLocksInDirectory(sessionDataPath, options);

  let sessionDirs = [];
  try {
    sessionDirs = fs
      .readdirSync(sessionDataPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
      .map((entry) => path.join(sessionDataPath, entry.name));
  } catch (_error) {
    return removed;
  }

  for (const sessionDir of sessionDirs) {
    removed += cleanChromiumLocksInDirectory(sessionDir, {
      ...options,
      maxDepth: 4,
    });
  }

  return removed;
}

function clearRuntimeProcessLocks(sessionDataPath) {
  if (!sessionDataPath || !fs.existsSync(sessionDataPath)) {
    return 0;
  }

  let removed = 0;
  let sessionDirs = [];

  try {
    sessionDirs = fs
      .readdirSync(sessionDataPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
      .map((entry) => path.join(sessionDataPath, entry.name));
  } catch (_error) {
    return 0;
  }

  for (const sessionDir of sessionDirs) {
    const lockPath = path.join(sessionDir, ".runtime.lock");
    if (removePathIfExists(lockPath)) {
      removed += 1;
    }
  }

  return removed;
}

module.exports = {
  CHROMIUM_LOCK_NAMES,
  resolveWhatsappSessionDataPath,
  isChromiumLockEntry,
  cleanChromiumLocksInDirectory,
  cleanRestaurantSessionLocks,
  cleanAllWhatsappSessionLocks,
  clearRuntimeProcessLocks,
};
