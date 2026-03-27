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

function createRequireAuth({ authService, logger }) {
  return async function requireAuth(req, res, next) {
    const idToken = extractBearerToken(req);
    if (!idToken) {
      sendAuthError(res, authError(401, "missing_token", "Missing Bearer token"));
      return;
    }

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
      next();
    } catch (error) {
      logger.warn("Portal auth failed", {
        message: error.message,
        statusCode: error.statusCode || 0,
      });
      sendAuthError(res, error);
    }
  };
}

module.exports = {
  createRequireAuth,
};
