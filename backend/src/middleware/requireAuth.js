const { authError, sendAuthError } = require("../auth/authErrors");

function extractBearerToken(req) {
  const header = req.header("authorization");
  if (!header || typeof header !== "string") {
    return "";
  }

  const trimmed = header.trim();
  const match = trimmed.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return "";
  }

  return match[1].trim();
}

function summarizeToken(idToken) {
  const normalized = String(idToken || "").trim();
  return {
    present: Boolean(normalized),
    length: normalized.length,
    preview: normalized ? normalized.slice(0, 12) : "",
  };
}

function createRequireAuth({ authService, logger }) {
  return async function requireAuth(req, res, next) {
    const idToken = extractBearerToken(req);
    if (!idToken) {
      logger.warn("Portal auth missing bearer token", {
        method: req.method,
        path: req.originalUrl,
      });
      sendAuthError(res, authError(401, "missing_token", "Missing Bearer token"));
      return;
    }

    logger.debug("Portal auth middleware started", {
      method: req.method,
      path: req.originalUrl,
      token: summarizeToken(idToken),
    });

    try {
      const user = await authService.verifySessionByIdToken(idToken);
      req.user = user;
      req.auth = {
        type: "portal_user",
        keyId: user.uid,
        name: user.displayName || user.email || user.uid,
        restaurantId:
          (req.params && req.params.restaurantId) ||
          (req.context && req.context.restaurantId) ||
          user.restaurantId ||
          "",
        scopes: user.permissions || [],
      };
      logger.debug("Portal auth middleware succeeded", {
        method: req.method,
        path: req.originalUrl,
        uid: user.uid,
        role: user.role,
        restaurantId: user.restaurantId,
      });
      next();
    } catch (error) {
      logger.warn("Portal auth failed", {
        message: error.message,
        statusCode: error.statusCode || 0,
        method: req.method,
        path: req.originalUrl,
      });
      sendAuthError(res, error);
    }
  };
}

module.exports = {
  createRequireAuth,
};
