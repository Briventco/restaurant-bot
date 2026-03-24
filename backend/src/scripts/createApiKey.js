#!/usr/bin/env node
require("dotenv").config();
const crypto = require("crypto");
const apiKeyRepo = require("../repositories/apiKeyRepo");
const logger = require("../infra/logger");

function usage() {
  console.log(
    "Usage: npm run create:api-key -- <restaurantId> <keyId> <secret> [scopesCsv] [name]"
  );
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

async function run() {
  const [, , restaurantId, keyId, secret, scopesCsv, name] = process.argv;

  if (!restaurantId || !keyId || !secret) {
    usage();
    process.exit(1);
  }

  const scopes = scopesCsv
    ? scopesCsv
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean)
    : ["*"];

  const result = await apiKeyRepo.upsertApiKey(restaurantId, keyId, {
    restaurantId,
    keyId,
    name: name || keyId,
    secretHash: hashSecret(secret),
    scopes,
    isActive: true,
    revokedAt: null,
    expiresAt: null,
  });

  logger.info("API key upserted", {
    restaurantId,
    keyId: result.id,
    scopes,
  });
}

run().catch((error) => {
  logger.error("Failed to upsert API key", {
    message: error.message,
  });
  process.exit(1);
});
