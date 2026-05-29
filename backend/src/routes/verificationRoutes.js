/**
 * Verification Routes
 *
 * Super-admin routes:
 *   GET  /api/v1/admin/verification/pending-count  — badge count for sidebar
 *   GET  /api/v1/admin/verification/pending        — list all pending restaurants
 *   POST /api/v1/admin/restaurants/:restaurantId/verify — approve or reject
 *
 * Restaurant-admin route (bypasses the verification gate so rejected admins can still resubmit):
 *   POST /api/v1/restaurants/:restaurantId/verification/resubmit
 */

const { Router } = require("express");
const { ROLES } = require("../auth/permissions");
const { validateBody } = require("../middleware/validateBody");

function createVerificationRoutes({
  requireApiKey,
  requireRole,
  restaurantRepo,
  logger = console,
}) {
  const router = Router();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function restaurantSummary(r) {
    return {
      id: r.id,
      name: String(r.name || ""),
      email: String(r.email || ""),
      phone: String(r.phone || ""),
      verificationStatus: String(r.verificationStatus || "approved"),
      verificationSubmittedAt: r.verificationSubmittedAt || null,
      verificationRejectionReason: String(r.verificationRejectionReason || ""),
      createdAt: r.createdAt || null,
    };
  }

  // ── GET /admin/verification/pending-count ──────────────────────────────────
  router.get(
    "/admin/verification/pending-count",
    requireApiKey,
    requireRole([ROLES.SUPER_ADMIN]),
    async (req, res, next) => {
      try {
        const all = await restaurantRepo.listRestaurants();
        const count = all.filter(
          (r) => String(r.verificationStatus || "approved") === "pending"
        ).length;
        res.status(200).json({ success: true, count });
      } catch (error) {
        logger.error("GET /admin/verification/pending-count failed", {
          message: error.message,
        });
        next(error);
      }
    }
  );

  // ── GET /admin/verification/pending ───────────────────────────────────────
  router.get(
    "/admin/verification/pending",
    requireApiKey,
    requireRole([ROLES.SUPER_ADMIN]),
    async (req, res, next) => {
      try {
        const all = await restaurantRepo.listRestaurants();
        const pending = all
          .filter((r) => String(r.verificationStatus || "approved") === "pending")
          .map(restaurantSummary)
          .sort((a, b) => {
            // Oldest submissions first
            const ta = a.verificationSubmittedAt
              ? new Date(a.verificationSubmittedAt).getTime()
              : 0;
            const tb = b.verificationSubmittedAt
              ? new Date(b.verificationSubmittedAt).getTime()
              : 0;
            return ta - tb;
          });

        res.status(200).json({ success: true, restaurants: pending, count: pending.length });
      } catch (error) {
        logger.error("GET /admin/verification/pending failed", {
          message: error.message,
        });
        next(error);
      }
    }
  );

  // ── POST /admin/restaurants/:restaurantId/verify ──────────────────────────
  router.post(
    "/admin/restaurants/:restaurantId/verify",
    requireApiKey,
    requireRole([ROLES.SUPER_ADMIN]),
    validateBody({
      action: { type: "string", required: true },
      reason: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const { restaurantId } = req.params;
        const { action, reason = "" } = req.body;

        if (action !== "approve" && action !== "reject") {
          res.status(400).json({ error: 'action must be "approve" or "reject"' });
          return;
        }

        if (action === "reject" && !String(reason || "").trim()) {
          res.status(400).json({ error: "A rejection reason is required." });
          return;
        }

        const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
        if (!restaurant) {
          res.status(404).json({ error: "Restaurant not found." });
          return;
        }

        const updates =
          action === "approve"
            ? {
                verificationStatus: "approved",
                verificationRejectionReason: "",
                verificationReviewedAt: new Date().toISOString(),
                verificationReviewedBy: req.user ? req.user.uid : "system",
              }
            : {
                verificationStatus: "rejected",
                verificationRejectionReason: String(reason || "").trim(),
                verificationReviewedAt: new Date().toISOString(),
                verificationReviewedBy: req.user ? req.user.uid : "system",
              };

        await restaurantRepo.upsertRestaurant(restaurantId, updates);

        logger.info(`POST /admin/restaurants/:id/verify — ${action}`, {
          restaurantId,
          action,
          by: req.user && req.user.uid,
        });

        // TODO: send email notification via Resend API when implemented
        // notifyRestaurantVerification(restaurantId, action, reason);

        res.status(200).json({
          success: true,
          restaurantId,
          verificationStatus: updates.verificationStatus,
        });
      } catch (error) {
        logger.error("POST /admin/restaurants/:id/verify failed", {
          message: error.message,
        });
        next(error);
      }
    }
  );

  // ── POST /restaurants/:restaurantId/verification/resubmit ─────────────────
  // NOTE: This route intentionally does NOT use requireRestaurantAccess so that
  // rejected restaurant admins can still reach it. It validates restaurant
  // ownership manually using req.user.restaurantId instead.
  router.post(
    "/restaurants/:restaurantId/verification/resubmit",
    requireApiKey,
    async (req, res, next) => {
      try {
        const { restaurantId } = req.params;

        // Must be the restaurant admin for this restaurant
        if (
          !req.user ||
          req.user.role !== ROLES.RESTAURANT_ADMIN ||
          req.user.restaurantId !== restaurantId
        ) {
          res.status(403).json({
            error: "Only the restaurant admin can resubmit for verification.",
          });
          return;
        }

        const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
        if (!restaurant) {
          res.status(404).json({ error: "Restaurant not found." });
          return;
        }

        const currentStatus = String(restaurant.verificationStatus || "approved");
        if (currentStatus !== "rejected") {
          res.status(400).json({
            error: `Only rejected accounts can resubmit. Current status: ${currentStatus}`,
          });
          return;
        }

        await restaurantRepo.upsertRestaurant(restaurantId, {
          verificationStatus: "pending",
          verificationRejectionReason: "",
          verificationSubmittedAt: new Date().toISOString(),
        });

        logger.info("POST /restaurants/:id/verification/resubmit succeeded", {
          restaurantId,
          by: req.user.uid,
        });

        // TODO: notify super admins via Resend when implemented

        res.status(200).json({
          success: true,
          restaurantId,
          verificationStatus: "pending",
        });
      } catch (error) {
        logger.error("POST /restaurants/:id/verification/resubmit failed", {
          message: error.message,
        });
        next(error);
      }
    }
  );

  return router;
}

module.exports = { createVerificationRoutes };
