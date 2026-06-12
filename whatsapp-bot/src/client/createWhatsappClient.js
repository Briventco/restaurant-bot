const { Client, LocalAuth } = require("whatsapp-web.js");
const { resolveChromiumExecutablePath } = require("./chromiumDiagnostics");

function createWhatsappClient({
  clientId,
  protocolTimeoutMs,
  puppeteerArgs,
  puppeteerHeadless = true,
  puppeteerExecutablePath = "",
  authDataPath = "",
  logger = null,
}) {
  const resolvedChromium = resolveChromiumExecutablePath(puppeteerExecutablePath);
  const requiredArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--single-process",
    "--disable-gpu",
  ];
  const providedArgs = Array.isArray(puppeteerArgs) ? puppeteerArgs : [];
  const args = Array.from(new Set([...providedArgs, ...requiredArgs]));

  const launchConfig = {
    headless: Boolean(puppeteerHeadless),
    protocolTimeout: protocolTimeoutMs,
    args,
  };

  if (resolvedChromium.executablePath) {
    launchConfig.executablePath = resolvedChromium.executablePath;
  }

  if (logger) {
    logger.info("Configuring Puppeteer launch", {
      clientId,
      headless: launchConfig.headless,
      executablePath: launchConfig.executablePath || "",
      executablePathSource: resolvedChromium.source || "",
      resolutionError: resolvedChromium.resolutionError || "",
      args: launchConfig.args,
      protocolTimeoutMs: protocolTimeoutMs,
      authDataPath: String(authDataPath || ""),
    });
  }

  return new Client({
    authStrategy: new LocalAuth({
      clientId,
      dataPath: authDataPath || ".wwebjs_auth",
    }),
    webVersionCache: {
      type: "local",
    },
    puppeteer: launchConfig,
  });
}

module.exports = {
  createWhatsappClient,
};
