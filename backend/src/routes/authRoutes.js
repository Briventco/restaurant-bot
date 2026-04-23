const { Router } = require("express");
const { authError, sendAuthError } = require("../auth/authErrors");
const { validateBody } = require("../middleware/validateBody");

function summarizeToken(idToken) {
  const normalized = String(idToken || "").trim();
  return {
    present: Boolean(normalized),
    length: normalized.length,
    preview: normalized ? normalized.slice(0, 12) : "",
  };
}

function createAuthRoutes({
  requireAuth,
  authService,
  restaurantOnboardingService,
  logger = console,
}) {
  const router = Router();

  router.post(
    "/auth/restaurant-signup",
    validateBody({
      restaurantName: { type: "string", required: true, minLength: 2 },
      adminEmail: { type: "string", required: true, minLength: 5 },
      adminPassword: { type: "string", required: true, minLength: 6 },
      adminDisplayName: { type: "string", required: false },
      restaurantId: { type: "string", required: false },
      phone: { type: "string", required: false },
      address: { type: "string", required: false },
      timezone: { type: "string", required: false },
      openingHours: { type: "string", required: false },
      closingHours: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const created = await restaurantOnboardingService.createRestaurantWorkspace({
          restaurantName: req.body.restaurantName,
          adminEmail: req.body.adminEmail,
          adminPassword: req.body.adminPassword,
          adminDisplayName: req.body.adminDisplayName,
          restaurantId: req.body.restaurantId,
          phone: req.body.phone,
          address: req.body.address,
          timezone: req.body.timezone,
          openingHours: req.body.openingHours,
          closingHours: req.body.closingHours,
          seedSampleMenu: false,
          createdBy: "self_serve_signup",
          source: "self_serve_signup",
        });

        logger.info("POST /auth/restaurant-signup succeeded", {
          restaurantId: created.restaurant && created.restaurant.id,
          adminEmail: created.adminUser && created.adminUser.email,
        });
        res.status(201).json({
          success: true,
          ...created,
        });
      } catch (error) {
        if (error && error.statusCode === 409) {
          res.status(409).json({
            error: error.message,
          });
          return;
        }
        next(error);
      }
    }
  );

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
