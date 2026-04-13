const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");

function serializeSettings(restaurant) {
  const safeRestaurant = restaurant || {};
  const bot = safeRestaurant.bot || {};
  const payment = safeRestaurant.payment || {};

  return {
    name: String(safeRestaurant.name || "").trim(),
    email: String(safeRestaurant.email || "").trim(),
    phone: String(safeRestaurant.phone || "").trim(),
    address: String(safeRestaurant.address || "").trim(),
    openingHours: String(safeRestaurant.openingHours || "08:00").trim(),
    closingHours: String(safeRestaurant.closingHours || "22:00").trim(),
    acceptOrders: bot.enabled !== false,
    autoConfirm: Boolean(bot.autoConfirm),
    notifyOnOrder: bot.notifyOnOrder !== false,
    orderAlertRecipients: Array.isArray(bot.orderAlertRecipients)
      ? bot.orderAlertRecipients
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [],
    manualTransferEnabled: payment.manualTransferEnabled === true,
    bankName: String(payment.bankName || "").trim(),
    accountName: String(payment.accountName || "").trim(),
    accountNumber: String(payment.accountNumber || "").trim(),
    paymentInstructions: String(payment.paymentInstructions || "").trim(),
  };
}

function createSettingsRoutes({
  requireApiKey,
  requireRestaurantAccess,
  restaurantRepo,
  restaurantHealthService,
}) {
  const router = Router({ mergeParams: true });

  router.get(
    "/settings",
    requireApiKey(["settings.read"]),
    requireRestaurantAccess,
    async (req, res) => {
      res.status(200).json({
        settings: serializeSettings(req.restaurant),
      });
    }
  );

  router.put(
    "/settings",
    requireApiKey(["settings.write"]),
    requireRestaurantAccess,
    validateBody({
      name: { type: "string", required: true, minLength: 2 },
      email: { type: "string", required: false },
      phone: { type: "string", required: false },
      address: { type: "string", required: false },
      openingHours: { type: "string", required: false },
      closingHours: { type: "string", required: false },
      acceptOrders: { type: "boolean", required: false },
      autoConfirm: { type: "boolean", required: false },
      notifyOnOrder: { type: "boolean", required: false },
      orderAlertRecipients: {
        type: "array",
        required: false,
        custom: (value) => {
          if (!Array.isArray(value)) {
            return null;
          }

          const invalid = value.find((item) => typeof item !== "string");
          if (invalid !== undefined) {
            return "orderAlertRecipients must contain only strings";
          }

          return null;
        },
      },
      manualTransferEnabled: { type: "boolean", required: false },
      bankName: { type: "string", required: false },
      accountName: { type: "string", required: false },
      accountNumber: { type: "string", required: false },
      paymentInstructions: { type: "string", required: false },
    }),
    async (req, res, next) => {
      try {
        const currentRestaurant = req.restaurant || {};
        const currentBot = currentRestaurant.bot || {};

        const restaurant = await restaurantRepo.upsertRestaurant(req.restaurantId, {
          name: req.body.name.trim(),
          email: typeof req.body.email === "string" ? req.body.email.trim() : "",
          phone: typeof req.body.phone === "string" ? req.body.phone.trim() : "",
          address: typeof req.body.address === "string" ? req.body.address.trim() : "",
          openingHours:
            typeof req.body.openingHours === "string" && req.body.openingHours.trim()
              ? req.body.openingHours.trim()
              : String(currentRestaurant.openingHours || "08:00"),
          closingHours:
            typeof req.body.closingHours === "string" && req.body.closingHours.trim()
              ? req.body.closingHours.trim()
              : String(currentRestaurant.closingHours || "22:00"),
          bot: {
            ...currentBot,
            enabled:
              typeof req.body.acceptOrders === "boolean"
                ? req.body.acceptOrders
                : currentBot.enabled !== false,
            autoConfirm:
              typeof req.body.autoConfirm === "boolean"
                ? req.body.autoConfirm
                : Boolean(currentBot.autoConfirm),
            notifyOnOrder:
              typeof req.body.notifyOnOrder === "boolean"
                ? req.body.notifyOnOrder
                : currentBot.notifyOnOrder !== false,
            orderAlertRecipients: Array.isArray(req.body.orderAlertRecipients)
              ? req.body.orderAlertRecipients
                  .map((value) => String(value || "").trim())
                  .filter(Boolean)
              : Array.isArray(currentBot.orderAlertRecipients)
                ? currentBot.orderAlertRecipients
                : [],
          },
          payment: {
            ...(currentRestaurant.payment || {}),
            manualTransferEnabled:
              typeof req.body.manualTransferEnabled === "boolean"
                ? req.body.manualTransferEnabled
                : currentRestaurant.payment?.manualTransferEnabled === true,
            bankName:
              typeof req.body.bankName === "string" ? req.body.bankName.trim() : "",
            accountName:
              typeof req.body.accountName === "string" ? req.body.accountName.trim() : "",
            accountNumber:
              typeof req.body.accountNumber === "string"
                ? req.body.accountNumber.trim()
                : "",
            paymentInstructions:
              typeof req.body.paymentInstructions === "string"
                ? req.body.paymentInstructions.trim()
                : "",
          },
          flow: {
            ...(currentRestaurant.flow || {}),
            allowDirectAwaitingPaymentFromPending:
              typeof req.body.manualTransferEnabled === "boolean"
                ? req.body.manualTransferEnabled
                : currentRestaurant.payment?.manualTransferEnabled === true,
          },
        });
        if (restaurantHealthService) {
          await restaurantHealthService.evaluateAndPersistRestaurantHealth({
            restaurantId: req.restaurantId,
            source: "settings_updated",
          });
        }

        res.status(200).json({
          settings: serializeSettings(restaurant),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createSettingsRoutes,
};
