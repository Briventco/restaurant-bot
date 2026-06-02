const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");
const { ROLES } = require("../auth/permissions");

function createStaffRoutes({
  requireApiKey,
  requireRestaurantAccess,
  admin,
  userRepo,
  logger = console,
}) {
  const router = Router({ mergeParams: true });

  // ── Middleware: all staff routes need auth + restaurant scope ──────────────
  // requireApiKey is a factory — call it with () to get the actual middleware.
  // Using requireApiKey directly (without parens) would pass the factory to
  // Express, which would call it with (req, res, next) as args, return a
  // middleware function without executing it, and hang every request forever.
  router.use(requireApiKey());
  router.use(requireRestaurantAccess);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isRestaurantAdmin(req) {
    return req.user && req.user.role === ROLES.RESTAURANT_ADMIN;
  }

  function staffSummary(profile) {
    return {
      uid: profile.uid || profile.id,
      id: profile.uid || profile.id,
      displayName: String(profile.displayName || profile.name || ""),
      email: String(profile.email || ""),
      phone: String(profile.phone || ""),
      role: String(profile.role || "restaurant_staff"),
      jobTitle: String(profile.jobTitle || ""),
      isActive: profile.isActive !== false,
      restaurantId: String(profile.restaurantId || ""),
      createdAt: profile.createdAt || null,
      updatedAt: profile.updatedAt || null,
    };
  }

  // ── GET /staff ─────────────────────────────────────────────────────────────
  router.get("/staff", async (req, res, next) => {
    try {
      const { restaurantId } = req.params;

      const allUsers = await userRepo.listUsersByRestaurantId(restaurantId);
      const staff = allUsers
        .filter((u) => u.role === ROLES.RESTAURANT_STAFF || u.role === ROLES.RESTAURANT_ADMIN)
        .map(staffSummary);

      logger.info("GET /staff succeeded", { restaurantId, count: staff.length });
      res.status(200).json({ success: true, staff });
    } catch (error) {
      logger.error("GET /staff failed", { message: error.message });
      next(error);
    }
  });

  // ── POST /staff ────────────────────────────────────────────────────────────
  router.post(
    "/staff",
    validateBody({
      displayName: { type: "string", required: true, minLength: 2 },
      email: { type: "string", required: true, minLength: 5 },
      password: { type: "string", required: true, minLength: 6 },
      phone: { type: "string", required: false },
      jobTitle: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        if (!isRestaurantAdmin(req)) {
          res.status(403).json({ error: "Only restaurant admins can create staff." });
          return;
        }

        const { restaurantId } = req.params;
        const { displayName, email, password, phone = "", jobTitle = "" } = req.body;

        // Create Firebase Auth user
        let authUser;
        try {
          authUser = await admin.auth().createUser({
            email: String(email).trim().toLowerCase(),
            password: String(password),
            displayName: String(displayName).trim(),
            disabled: false,
          });
        } catch (error) {
          if (error && error.code === "auth/email-already-exists") {
            res.status(409).json({ error: "A user with that email already exists." });
            return;
          }
          throw error;
        }

        // Persist user profile in Firestore
        const profile = await userRepo.upsertUser(authUser.uid, {
          uid: authUser.uid,
          email: String(email).trim().toLowerCase(),
          displayName: String(displayName).trim(),
          phone: String(phone || "").trim(),
          jobTitle: String(jobTitle || "").trim(),
          role: ROLES.RESTAURANT_STAFF,
          restaurantId,
          isActive: true,
          createdBy: req.user.uid,
        });

        logger.info("POST /staff succeeded", {
          restaurantId,
          newUid: authUser.uid,
          email,
        });

        res.status(201).json({ success: true, staff: staffSummary(profile) });
      } catch (error) {
        logger.error("POST /staff failed", { message: error.message });
        next(error);
      }
    }
  );

  // ── PATCH /staff/:staffId ──────────────────────────────────────────────────
  router.patch(
    "/staff/:staffId",
    validateBody({
      displayName: { type: "string", required: false },
      phone: { type: "string", required: false },
      jobTitle: { type: "string", required: false },
      isActive: { type: "boolean", required: false },
    }),
    async (req, res, next) => {
      try {
        if (!isRestaurantAdmin(req)) {
          res.status(403).json({ error: "Only restaurant admins can update staff." });
          return;
        }

        const { restaurantId, staffId } = req.params;

        // Verify staff belongs to this restaurant
        const existing = await userRepo.getUserByUid(staffId);
        if (!existing || existing.restaurantId !== restaurantId) {
          res.status(404).json({ error: "Staff member not found." });
          return;
        }

        const updates = {};
        if (req.body.displayName !== undefined) {
          updates.displayName = String(req.body.displayName).trim();
          // Sync display name to Firebase Auth
          await admin.auth().updateUser(staffId, { displayName: updates.displayName });
        }
        if (req.body.phone !== undefined) updates.phone = String(req.body.phone).trim();
        if (req.body.jobTitle !== undefined) updates.jobTitle = String(req.body.jobTitle).trim();
        if (req.body.isActive !== undefined) {
          updates.isActive = Boolean(req.body.isActive);
          await admin.auth().updateUser(staffId, { disabled: !updates.isActive });
        }

        const updated = await userRepo.upsertUser(staffId, updates);

        logger.info("PATCH /staff/:staffId succeeded", { restaurantId, staffId });
        res.status(200).json({ success: true, staff: staffSummary(updated) });
      } catch (error) {
        logger.error("PATCH /staff/:staffId failed", { message: error.message });
        next(error);
      }
    }
  );

  // ── DELETE /staff/:staffId ─────────────────────────────────────────────────
  router.delete("/staff/:staffId", async (req, res, next) => {
    try {
      if (!isRestaurantAdmin(req)) {
        res.status(403).json({ error: "Only restaurant admins can delete staff." });
        return;
      }

      const { restaurantId, staffId } = req.params;

      // Prevent self-deletion
      if (req.user.uid === staffId) {
        res.status(400).json({ error: "You cannot delete your own account." });
        return;
      }

      const existing = await userRepo.getUserByUid(staffId);
      if (!existing || existing.restaurantId !== restaurantId) {
        res.status(404).json({ error: "Staff member not found." });
        return;
      }

      // Disable in Firebase Auth instead of hard-delete (preserves audit trail)
      await admin.auth().updateUser(staffId, { disabled: true });
      await userRepo.upsertUser(staffId, { isActive: false });

      logger.info("DELETE /staff/:staffId succeeded", { restaurantId, staffId });
      res.status(200).json({ success: true, message: "Staff member deactivated." });
    } catch (error) {
      logger.error("DELETE /staff/:staffId failed", { message: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createStaffRoutes };
