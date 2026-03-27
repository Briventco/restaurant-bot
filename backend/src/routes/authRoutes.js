const { Router } = require("express");
const { authError, sendAuthError } = require("../auth/authErrors");

function createAuthRoutes({ requireAuth, authService }) {
  const router = Router();

  router.post("/auth/session", async (req, res) => {
    try {
      const idToken = req.body && req.body.idToken;
      if (typeof idToken !== "string" || !idToken.trim()) {
        sendAuthError(
          res,
          authError(400, "invalid_request", "Body field idToken is required")
        );
        return;
      }

      const user = await authService.verifySessionByIdToken(idToken);
      res.status(200).json({
        success: true,
        user,
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.get("/auth/me", requireAuth, (req, res) => {
    res.status(200).json({
      success: true,
      user: req.user,
    });
  });

  router.post("/auth/logout", requireAuth, (_req, res) => {
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
