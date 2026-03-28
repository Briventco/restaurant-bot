#!/usr/bin/env node

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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

  const configuredCacheDir = String(
    process.env.PUPPETEER_CACHE_DIR || ".cache/puppeteer"
  ).trim();
  const cacheDir = path.isAbsolute(configuredCacheDir)
    ? configuredCacheDir
    : path.resolve(process.cwd(), configuredCacheDir);
  process.env.PUPPETEER_CACHE_DIR = cacheDir;
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log(
    `[chromium-install] Installing Chromium for Puppeteer (cacheDir=${cacheDir})...`
  );

  execSync("npx puppeteer browsers install chrome", {
    stdio: "inherit",
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: cacheDir,
    },
  });

  console.log(
    `[chromium-install] Chromium install completed (cacheDir=${cacheDir}).`
  );
}

try {
  main();
} catch (error) {
  console.error("[chromium-install] Chromium install failed.");
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
