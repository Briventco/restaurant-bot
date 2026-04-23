const { Router } = require("express");
const { authError, sendAuthError } = require("../auth/authErrors");

function summarizeToken(idToken) {
  const normalized = String(idToken || "").trim();
  return {
    present: Boolean(normalized),
    length: normalized.length,
    preview: normalized ? normalized.slice(0, 12) : "",
  };
}

function createAuthRoutes({ requireAuth, authService, logger = console }) {
  const router = Router();

  router.post("/auth/session", async (req, res) => {
    try {
      const idToken = req.body && req.body.idToken;
      logger.info("POST /auth/session received", {
        token: summarizeToken(idToken),
      });
      if (typeof idToken !== "string" || !idToken.trim()) {
        sendAuthError(
          res,
          authError(400, "invalid_request", "Body field idToken is required")
        );
        return;
      }

      const user = await authService.verifySessionByIdToken(idToken);
      logger.info("POST /auth/session succeeded", {
        uid: user.uid,
        role: user.role,
        restaurantId: user.restaurantId,
      });
      res.status(200).json({
        success: true,
        user,
      });
    } catch (error) {
      logger.warn("POST /auth/session failed", {
        message: error.message,
        statusCode: error.statusCode || 0,
      });
      sendAuthError(res, error);
    }
  });

  router.get("/auth/me", requireAuth, (req, res) => {
    logger.info("GET /auth/me succeeded", {
      uid: req.user && req.user.uid,
      role: req.user && req.user.role,
      restaurantId: req.user && req.user.restaurantId,
    });
    res.status(200).json({
      success: true,
      user: req.user,
    });
  });

  router.post("/auth/logout", requireAuth, (_req, res) => {
    logger.info("POST /auth/logout succeeded");
    res.status(200).json({
      success: true,
      message: "Logout acknowledged",
    });
  });

  return router;
}

module.exports = {
  createAuthRoutes,
};
