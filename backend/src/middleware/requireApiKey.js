const crypto = require("crypto");

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function extractRestaurantId(req) {
  return (
    (req.params && req.params.restaurantId) ||
    (req.context && req.context.restaurantId) ||
    ""
  );
}

function parseKeyHeader(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const index = value.indexOf(".");
  if (index <= 0 || index === value.length - 1) {
    return null;
  }

  return {
    keyId: value.slice(0, index),
    secret: value.slice(index + 1),
  };
}

function hasAllScopes(keyScopes, requiredScopes) {
  if (!requiredScopes || requiredScopes.length === 0) {
    return true;
  }

  const scopes = Array.isArray(keyScopes) ? keyScopes : [];

  if (scopes.includes("*")) {
    return true;
  }

  return requiredScopes.every((scope) => scopes.includes(scope));
}

function normalizeScopeRule(requiredScopes) {
  if (!requiredScopes) {
    return { allOf: [] };
  }

  if (Array.isArray(requiredScopes)) {
    return { allOf: requiredScopes };
  }

  if (typeof requiredScopes === "string") {
    return { allOf: [requiredScopes] };
  }

  if (typeof requiredScopes === "object") {
    const allOf = Array.isArray(requiredScopes.allOf)
      ? requiredScopes.allOf
      : [];
    const anyOf = Array.isArray(requiredScopes.anyOf)
      ? requiredScopes.anyOf
      : [];

    if (!allOf.length && !anyOf.length) {
      return { allOf: [] };
    }

    return { allOf, anyOf };
  }

  return { allOf: [] };
}

function hasScopeRule(keyScopes, scopeRule) {
  const allOf = scopeRule && Array.isArray(scopeRule.allOf) ? scopeRule.allOf : [];
  const anyOf = scopeRule && Array.isArray(scopeRule.anyOf) ? scopeRule.anyOf : [];

  if (!hasAllScopes(keyScopes, allOf)) {
    return false;
  }

  if (!anyOf.length) {
    return true;
  }

  return anyOf.some((scope) => hasAllScopes(keyScopes, [scope]));
}

function createRequireApiKey({ apiKeyRepo, logger }) {
  return function requireApiKey(requiredScopes = []) {
    const scopeRule = normalizeScopeRule(requiredScopes);

    return async function apiKeyMiddleware(req, res, next) {
      try {
        const restaurantId = extractRestaurantId(req);
        if (!restaurantId) {
          res.status(400).json({ error: "Missing restaurantId in request context" });
          return;
        }

        const parsed = parseKeyHeader(req.header("x-api-key"));
        if (!parsed) {
          res.status(401).json({ error: "Missing or invalid x-api-key format" });
          return;
        }

        const keyDoc = await apiKeyRepo.getApiKeyById(restaurantId, parsed.keyId);
        if (!keyDoc) {
          res.status(401).json({ error: "Invalid API key" });
          return;
        }

        if (!keyDoc.isActive || keyDoc.revokedAt) {
          res.status(401).json({ error: "API key is inactive or revoked" });
          return;
        }

        if (keyDoc.expiresAt) {
          const expiresAt = new Date(keyDoc.expiresAt).getTime();
          if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
            res.status(401).json({ error: "API key is expired" });
            return;
          }
        }

        const incomingHash = hashSecret(parsed.secret);
        if (!safeEqual(incomingHash, keyDoc.secretHash || "")) {
          res.status(401).json({ error: "Invalid API key" });
          return;
        }

        if (!hasScopeRule(keyDoc.scopes, scopeRule)) {
          res.status(403).json({
            error: "API key does not have the required scope",
            requiredScopes: scopeRule,
          });
          return;
        }

        req.auth = {
          restaurantId,
          keyId: parsed.keyId,
          scopes: keyDoc.scopes || [],
          name: keyDoc.name || "",
        };

        next();
      } catch (error) {
        logger.error("API key auth failed", { message: error.message });
        res.status(500).json({ error: "Authentication failed" });
      }
    };
  };
}

module.exports = {
  createRequireApiKey,
  hashSecret,
};
