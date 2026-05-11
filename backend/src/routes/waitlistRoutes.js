const { Router } = require("express");
const { db, FieldValue } = require("../infra/firebase");
const { sendWaitlistConfirmation } = require("../domain/services/emailService");
const logger = require("../infra/logger");

const WAITLIST_COLLECTION = "waitlist";

async function addToWaitlist({ businessName, whatsappNumber, email }) {
  await db.collection(WAITLIST_COLLECTION).add({
    businessName: String(businessName).trim(),
    whatsappNumber: String(whatsappNumber).trim(),
    email: String(email).trim().toLowerCase(),
    source: "landing_page",
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function isEmailOnWaitlist(email) {
  const snapshot = await db
    .collection(WAITLIST_COLLECTION)
    .where("email", "==", String(email).trim().toLowerCase())
    .limit(1)
    .get();

  return !snapshot.empty;
}

function createWaitlistRoutes() {
  const router = Router();

  router.post("/waitlist/join", async (req, res, next) => {
    try {
      const { businessName, whatsappNumber, email } = req.body || {};

      // Validate required fields
      if (
        !String(businessName || "").trim() ||
        !String(whatsappNumber || "").trim() ||
        !String(email || "").trim()
      ) {
        return res.status(400).json({
          error: "businessName, whatsappNumber, and email are all required.",
        });
      }

      // Duplicate check
      const alreadyExists = await isEmailOnWaitlist(email);
      if (alreadyExists) {
        return res.status(409).json({
          error: "Looks like you're already on our waitlist 👍",
        });
      }

      // Save to Firestore
      await addToWaitlist({ businessName, whatsappNumber, email });

      // Send confirmation email — failure is non-fatal
      try {
        await sendWaitlistConfirmation(String(email).trim(), String(businessName).trim());
      } catch (emailErr) {
        logger.error("[waitlist] Failed to send confirmation email — non-fatal", {
          email: String(email).trim(),
          error: String((emailErr && emailErr.message) || emailErr),
        });
      }

      return res.status(200).json({
        success: true,
        message: "You're on the list! Check your email 🎉",
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createWaitlistRoutes,
};
