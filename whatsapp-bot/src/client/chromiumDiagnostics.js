const fs = require("node:fs");

function safeReadPackageVersion(moduleName) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const pkg = require(`${moduleName}/package.json`);
    return String(pkg.version || "");
  } catch (_error) {
    return "";
  }
}

function resolveChromiumExecutablePath(explicitPath = "") {
  const normalizedExplicit = String(explicitPath || "").trim();
  if (normalizedExplicit) {
    return {
      executablePath: normalizedExplicit,
      source: "config",
      resolutionError: "",
    };
  }

  const envPath = String(
    process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || ""
  ).trim();
  if (envPath) {
    return {
      executablePath: envPath,
      source: "env",
      resolutionError: "",
    };
  }

  try {
    // eslint-disable-next-line global-require
    const puppeteer = require("puppeteer");
    const executablePath = String(puppeteer.executablePath() || "").trim();
    return {
      executablePath,
      source: "puppeteer",
      resolutionError: "",
    };
  } catch (error) {
    return {
      executablePath: "",
      source: "puppeteer",
      resolutionError: String((error && error.message) || "puppeteer_resolution_failed"),
    };
  }
}

function collectChromiumDiagnostics(explicitPath = "") {
  const resolved = resolveChromiumExecutablePath(explicitPath);
  const executablePath = resolved.executablePath;
  const executableExists = executablePath ? fs.existsSync(executablePath) : false;
  const puppeteerVersion = safeReadPackageVersion("puppeteer");
  const puppeteerCoreVersion = safeReadPackageVersion("puppeteer-core");
  const implementation = puppeteerVersion
    ? "puppeteer"
    : puppeteerCoreVersion
      ? "puppeteer-core"
      : "unknown";

  return {
    implementation,
    puppeteerVersion,
    puppeteerCoreVersion,
    executablePath,
    executablePathSource: resolved.source,
    executableExists,
    ok: Boolean(executablePath && executableExists),
    skipDownloadEnv: String(process.env.PUPPETEER_SKIP_DOWNLOAD || ""),
    cacheDir: String(process.env.PUPPETEER_CACHE_DIR || ""),
    resolutionError: resolved.resolutionError || "",
  };
}

module.exports = {
  resolveChromiumExecutablePath,
  collectChromiumDiagnostics,
};
