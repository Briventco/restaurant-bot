const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

function findChromeExecutableInCache(cacheDir) {
  if (!cacheDir || !fs.existsSync(cacheDir) || !fs.statSync(cacheDir).isDirectory()) {
    return "";
  }

  const chromeRoot = path.join(cacheDir, "chrome");
  if (!fs.existsSync(chromeRoot) || !fs.statSync(chromeRoot).isDirectory()) {
    return "";
  }

  const versionDirs = fs.readdirSync(chromeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const versionDir of versionDirs) {
    const versionPath = path.join(chromeRoot, versionDir);
    const executable = findChromeExecutableRecursively(versionPath, 4);
    if (executable) {
      return executable;
    }
  }

  return "";
}

function findChromeExecutableRecursively(directory, depth) {
  if (depth < 0 || !fs.existsSync(directory)) {
    return "";
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidatePath = path.join(directory, entry.name);
    if (
      entry.isFile() &&
      (entry.name === "chrome" || entry.name === "chrome.exe" || entry.name === "msedge.exe")
    ) {
      return candidatePath;
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findChromeExecutableRecursively(path.join(directory, entry.name), depth - 1);
      if (found) {
        return found;
      }
    }
  }

  return "";
}

function resolveBrowserExecutablePath(configuredPath = "") {
  const cacheDir = String(process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), ".cache/puppeteer")).trim();
  const cachedExecutable = findChromeExecutableInCache(cacheDir);

  const candidates = [
    configuredPath,
    process.env.WHATSAPP_BROWSER_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_EXECUTABLE_PATH,
    cachedExecutable,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function sanitizeClientId(restaurantId) {
  return String(restaurantId).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeOutboundRecipient(to) {
  const value = String(to || "").trim();
  if (!value) {
    return value;
  }

  if (value.includes("@")) {
    return value;
  }

  const digits = value.replace(/\D/g, "");
  if (!digits) {
    return value;
  }

  return `${digits}@c.us`;
}

function resolveSessionDataPath() {
  const explicit = String(process.env.WHATSAPP_SESSION_DATA_PATH || "").trim();
  if (explicit) {
    return explicit;
  }

  const renderDiskPath = String(process.env.RENDER_DISK_PATH || "").trim();
  if (renderDiskPath) {
    return path.join(renderDiskPath, "wwebjs_auth");
  }

  return path.join(process.cwd(), ".wwebjs_auth");
}

function ensureDirectoryExists(directoryPath) {
  try {
    fs.mkdirSync(directoryPath, { recursive: true });
  } catch (_error) {
    // Best effort; client initialization will fail later with a clearer error.
  }
}

function isBrowserAlreadyRunningError(error) {
  const message = String(error && error.message ? error.message : "").toLowerCase();
  return message.includes("browser is already running for");
}

function createWhatsappClientRegistry({
  sessionRepo,
  sessionEventRepo,
  logger,
  qrTtlSeconds,
  onInboundMessage,
  browserExecutablePath = "",
}) {
  const clients = new Map();
  const qrCache = new Map();
  const startLocks = new Map();
  const resolvedBrowserExecutablePath = resolveBrowserExecutablePath(
    browserExecutablePath
  );
  const sessionDataPath = resolveSessionDataPath();
  ensureDirectoryExists(sessionDataPath);
  logger.info("WhatsApp session auth storage configured", {
    sessionDataPath,
    usingRenderDiskPath: Boolean(String(process.env.RENDER_DISK_PATH || "").trim()),
    usingExplicitPath: Boolean(String(process.env.WHATSAPP_SESSION_DATA_PATH || "").trim()),
  });
  const EVENT_SEVERITY_BY_NAME = {
    start_requested: "info",
    qr_generated: "info",
    authenticated: "info",
    connected: "info",
    manual_disconnect: "info",
    disconnected: "warning",
    auth_failure: "error",
    start_failed: "error",
  };

  function removeClient(restaurantId) {
    clients.delete(restaurantId);
  }

  async function setSessionState(restaurantId, patch) {
    try {
      await sessionRepo.upsertSession(restaurantId, "whatsapp-web", patch);
    } catch (error) {
      logger.error("Failed to update WhatsApp session state", {
        restaurantId,
        message: error.message,
      });
    }
  }

  function setQrCache(restaurantId, qr) {
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + qrTtlSeconds * 1000);

    qrCache.set(restaurantId, {
      qr,
      generatedAt,
      expiresAt,
    });

    void setSessionState(restaurantId, {
      status: "qr_required",
      qrAvailable: true,
      qrGeneratedAt: generatedAt.toISOString(),
      qrExpiresAt: expiresAt.toISOString(),
      lastError: "",
    });
  }

  function clearQrCache(restaurantId) {
    qrCache.delete(restaurantId);
    void setSessionState(restaurantId, {
      qrAvailable: false,
    });
  }

  function bindClientEvents(restaurantId, client) {
    client.on("qr", (qr) => {
      logger.info("WhatsApp QR generated", { restaurantId });
      setQrCache(restaurantId, qr);
      void createSessionEvent(restaurantId, "qr_generated", {
        expiresAt: new Date(Date.now() + qrTtlSeconds * 1000).toISOString(),
      });
    });

    client.on("authenticated", () => {
      logger.info("WhatsApp authenticated", { restaurantId });
      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "authenticating",
      });
      void createSessionEvent(restaurantId, "authenticated");
    });

    client.on("ready", () => {
      logger.info("WhatsApp connected", { restaurantId });
      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "connected",
        qrAvailable: false,
        lastConnectedAt: new Date().toISOString(),
        lastError: "",
      });
      void createSessionEvent(restaurantId, "connected");
    });

    client.on("disconnected", (reason) => {
      logger.warn("WhatsApp disconnected", {
        restaurantId,
        reason,
      });

      removeClient(restaurantId);
      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: reason || "",
      });
      void createSessionEvent(restaurantId, "disconnected", {
        reason: reason || "",
      });

      // Auto-restart after 5 seconds if not a manual disconnect
      if (reason !== "LOGOUT" && reason !== "CONFLICT") {
        logger.info("Scheduling auto-restart for WhatsApp session", {
          restaurantId,
          reason,
        });
        setTimeout(() => {
          void startSession(restaurantId);
        }, 5000);
      }
    });

    client.on("auth_failure", (message) => {
      logger.error("WhatsApp auth failure", {
        restaurantId,
        message,
      });

      removeClient(restaurantId);
      clearQrCache(restaurantId);
      void setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastError: message || "auth_failure",
      });
      void createSessionEvent(restaurantId, "auth_failure", {
        message: message || "auth_failure",
      });
    });

    client.on("message", async (message) => {
      if (typeof onInboundMessage !== "function") {
        return;
      }

      try {
        await onInboundMessage({
          restaurantId,
          message,
        });
      } catch (error) {
        logger.error("Inbound WhatsApp message handler failed", {
          restaurantId,
          message: error.message,
        });
      }
    });
  }

  async function startSession(restaurantId) {
    const inFlightStart = startLocks.get(restaurantId);
    if (inFlightStart) {
      return inFlightStart;
    }

    const startPromise = (async () => {
    const existing = clients.get(restaurantId);
    if (existing) {
      const existingStatus = await getSessionStatus(restaurantId);
      if (
        ["disconnected", "auth_failure"].includes(
          String(existingStatus.status || "").trim().toLowerCase()
        )
      ) {
        try {
          await existing.client.destroy();
        } catch (_error) {
          // Best-effort cleanup before starting a fresh session.
        }
        removeClient(restaurantId);
      } else {
        return existingStatus;
      }
    }

    await setSessionState(restaurantId, {
      status: "starting",
      qrAvailable: false,
      qrGeneratedAt: null,
      qrExpiresAt: null,
    });
    await createSessionEvent(restaurantId, "start_requested");

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `restaurant_${sanitizeClientId(restaurantId)}`,
        dataPath: sessionDataPath,
      }),
      puppeteer: {
        headless: true,
        executablePath: resolvedBrowserExecutablePath || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
    });

    bindClientEvents(restaurantId, client);
    clients.set(restaurantId, { client });

    try {
      await client.initialize();
    } catch (error) {
      removeClient(restaurantId);
      clearQrCache(restaurantId);

      if (isBrowserAlreadyRunningError(error)) {
        logger.warn("WhatsApp browser profile already in use", {
          restaurantId,
          message: error.message,
        });
        await setSessionState(restaurantId, {
          status: "starting",
          qrAvailable: false,
          lastError:
            "Another WhatsApp browser process is already using this session profile. Stop the existing process and retry.",
        });
        await createSessionEvent(restaurantId, "start_failed", {
          message: error.message || "browser_profile_in_use",
        });
        return getSessionStatus(restaurantId);
      }

      await setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: error.message || "session_start_failed",
      });
      await createSessionEvent(restaurantId, "start_failed", {
        message: error.message || "session_start_failed",
      });
      throw error;
    }

    return getSessionStatus(restaurantId);
    })();

    startLocks.set(restaurantId, startPromise);
    try {
      return await startPromise;
    } finally {
      startLocks.delete(restaurantId);
    }
  }

  async function createSessionEvent(restaurantId, event, details = {}) {
    if (!sessionEventRepo || typeof sessionEventRepo.createSessionEvent !== "function") {
      return;
    }

    const normalizedEvent = String(event || "").trim().toLowerCase();

    try {
      await sessionEventRepo.createSessionEvent(restaurantId, {
        event: normalizedEvent,
        severity: EVENT_SEVERITY_BY_NAME[normalizedEvent] || "info",
        details,
      });
    } catch (error) {
      logger.error("Failed to write WhatsApp session event", {
        restaurantId,
        event,
        message: error.message,
      });
    }
  }

  async function sendMessage({ restaurantId, to, text }) {
    let entry = clients.get(restaurantId);
    if (!entry) {
      await startSession(restaurantId);
      entry = clients.get(restaurantId);
    }

    if (!entry) {
      throw new Error("Failed to initialize WhatsApp client");
    }

    const normalizedTo = normalizeOutboundRecipient(to);
    await entry.client.sendMessage(normalizedTo, text);
  }

  async function disconnectSession(restaurantId) {
    const entry = clients.get(restaurantId);
    if (!entry) {
      await setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: "",
      });
      return;
    }

    try {
      await entry.client.destroy();
    } finally {
      removeClient(restaurantId);
      clearQrCache(restaurantId);
      await setSessionState(restaurantId, {
        status: "disconnected",
        qrAvailable: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: "",
      });
      await createSessionEvent(restaurantId, "manual_disconnect");
    }
  }

  function getCurrentQr(restaurantId) {
    const record = qrCache.get(restaurantId);
    if (!record) {
      return null;
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      qrCache.delete(restaurantId);
      void setSessionState(restaurantId, {
        qrAvailable: false,
      });
      return null;
    }

    return {
      qr: record.qr,
      generatedAt: record.generatedAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  async function getSessionStatus(restaurantId) {
    const stored = await sessionRepo.getSession(restaurantId, "whatsapp-web");
    const qr = getCurrentQr(restaurantId);

    if (!stored) {
      return {
        restaurantId,
        status: "disconnected",
        qrAvailable: Boolean(qr),
        qrGeneratedAt: qr ? qr.generatedAt : null,
        qrExpiresAt: qr ? qr.expiresAt : null,
      };
    }

    return {
      ...stored,
      qrAvailable: Boolean(qr),
      qrGeneratedAt: qr ? qr.generatedAt : stored.qrGeneratedAt || null,
      qrExpiresAt: qr ? qr.expiresAt : stored.qrExpiresAt || null,
    };
  }

  // Heartbeat to keep sessions alive and auto-restart if needed
  const heartbeatIntervalMs = 60000; // Check every minute
  const heartbeatTimer = setInterval(async () => {
    for (const [restaurantId, entry] of clients.entries()) {
      try {
        // Skip if a start is already in progress
        if (startLocks.has(restaurantId)) {
          continue;
        }

        const status = await getSessionStatus(restaurantId);
        if (status.status !== "connected" && status.status !== "authenticating" && status.status !== "starting") {
          logger.info("Heartbeat detected disconnected session, restarting", {
            restaurantId,
            status: status.status,
          });
          void startSession(restaurantId);
        }
      } catch (error) {
        logger.error("Heartbeat check failed for WhatsApp session", {
          restaurantId,
          message: error.message,
        });
      }
    }
  }, heartbeatIntervalMs);

  // Cleanup on process exit
  process.on("beforeExit", () => {
    clearInterval(heartbeatTimer);
  });
  process.on("SIGINT", () => {
    clearInterval(heartbeatTimer);
  });
  process.on("SIGTERM", () => {
    clearInterval(heartbeatTimer);
  });

  return {
    startSession,
    sendMessage,
    disconnectSession,
    getSessionStatus,
    getCurrentQr,
  };
}

module.exports = {
  createWhatsappClientRegistry,
  normalizeOutboundRecipient,
};
