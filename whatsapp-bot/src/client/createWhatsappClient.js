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
  const launchConfig = {
    headless: Boolean(puppeteerHeadless),
    protocolTimeout: protocolTimeoutMs,
    args: Array.isArray(puppeteerArgs) ? puppeteerArgs : [],
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
    puppeteer: launchConfig,
  });
}

module.exports = {
  createWhatsappClient,
};
