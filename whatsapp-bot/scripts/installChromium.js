#!/usr/bin/env node

const { execSync } = require("node:child_process");

function toBoolean(value) {
  if (value === undefined || value === null) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function main() {
  if (toBoolean(process.env.PUPPETEER_SKIP_DOWNLOAD)) {
    console.warn(
      "[chromium-install] PUPPETEER_SKIP_DOWNLOAD is enabled; forcing explicit Chromium install."
    );
  }

  console.log("[chromium-install] Installing Chromium for Puppeteer...");

  execSync("npx puppeteer browsers install chrome", {
    stdio: "inherit",
  });

  console.log("[chromium-install] Chromium install completed.");
}

try {
  main();
} catch (error) {
  console.error("[chromium-install] Chromium install failed.");
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
