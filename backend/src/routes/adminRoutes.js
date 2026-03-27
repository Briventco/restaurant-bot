const { Router } = require("express");

function createAdminRoutes({ requireAuth, requireRole }) {
  const router = Router();
  const requireSuperAdmin = requireRole("super_admin");

  router.use(requireAuth, requireSuperAdmin);

  router.get("/dashboard", (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        message: "Super admin dashboard scaffold",
      },
    });
  });

  router.get("/restaurants", (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        items: [],
        message: "Restaurant listing scaffold",
      },
    });
  });

  router.get("/restaurants/:restaurantId", (req, res) => {
    res.status(200).json({
      success: true,
      data: {
        restaurantId: req.params.restaurantId,
        message: "Restaurant detail scaffold",
      },
    });
  });

  router.get("/sessions", (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        items: [],
        message: "Session monitor scaffold",
      },
    });
  });

  router.get("/outbox", (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        items: [],
        message: "Outbox monitor scaffold",
      },
    });
  });

  return router;
}

module.exports = {
  createAdminRoutes,
};
