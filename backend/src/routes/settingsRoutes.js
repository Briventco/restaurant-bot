const { Router } = require("express");
const { validateBody } = require("../middleware/validateBody");

function serializeSettings(restaurant) {
  const safeRestaurant = restaurant || {};
  const bot = safeRestaurant.bot || {};
  const payment = safeRestaurant.payment || {};
  const automatic = payment.automatic || {};

  return {
    name: String(safeRestaurant.name || "").trim(),
    email: String(safeRestaurant.email || "").trim(),
    phone: String(safeRestaurant.phone || "").trim(),
    address: String(safeRestaurant.address || "").trim(),
    timezone: String(safeRestaurant.timezone || "Africa/Lagos").trim(),
    openingHours: String(safeRestaurant.openingHours || "08:00").trim(),
    closingHours: String(safeRestaurant.closingHours || "22:00").trim(),
    acceptOrders: bot.enabled !== false,
    autoConfirm: Boolean(bot.autoConfirm),
    notifyOnOrder: bot.notifyOnOrder !== false,
    customWelcomeMessage: String(bot.customWelcomeMessage || "").trim(),
    orderAlertRecipients: Array.isArray(bot.orderAlertRecipients)
      ? bot.orderAlertRecipients
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [],
    orderAlertRecipient: Array.isArray(bot.orderAlertRecipients) && bot.orderAlertRecipients.length
      ? String(bot.orderAlertRecipients[0] || "").trim()
      : "",
    paymentAlertRecipients: Array.isArray(bot.paymentAlertRecipients)
      ? bot.paymentAlertRecipients
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [],
    manualTransferEnabled: payment.manualTransferEnabled === true,
    bankName: String(payment.bankName || "").trim(),
    accountName: String(payment.accountName || "").trim(),
    accountNumber: String(payment.accountNumber || "").trim(),
    paymentInstructions: String(payment.paymentInstructions || "").trim(),
    automaticPayment: {
      enabled: automatic.enabled === true,
      bankCode: String(automatic.bankCode || "").trim(),
      bankName: String(automatic.bankName || "").trim(),
      accountNumber: String(automatic.accountNumber || "").trim(),
      accountName: String(automatic.accountName || "").trim(),
      businessName: String(automatic.businessName || "").trim(),
      configured: Boolean(automatic.subaccountId),
    },
  };
}

function createSettingsRoutes({
  requireApiKey,
  requireRestaurantAccess,
  restaurantRepo,
  restaurantOnboardingService,
  restaurantHealthService,
  orderService,
  flutterwaveService,
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
      timezone: { type: "string", required: false },
      openingHours: { type: "string", required: false },
      closingHours: { type: "string", required: false },
      acceptOrders: { type: "boolean", required: false },
      autoConfirm: { type: "boolean", required: false },
      notifyOnOrder: { type: "boolean", required: false },
      orderAlertRecipient: { type: "string", required: false },
      customWelcomeMessage: {
        type: "string",
        required: false,
        custom: (value) => {
          if (value === undefined || value === null) return null;
          if (typeof value !== "string") return "customWelcomeMessage must be a string";
          if (value.trim().length > 2000) return "customWelcomeMessage must be 2000 characters or fewer";
          return null;
        },
      },
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
      paymentAlertRecipients: {
        type: "array",
        required: false,
        custom: (value) => {
          if (!Array.isArray(value)) {
            return null;
          }

          const invalid = value.find((item) => typeof item !== "string");
          if (invalid !== undefined) {
            return "paymentAlertRecipients must contain only strings";
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
        const hasOrderAlertRecipient = Object.prototype.hasOwnProperty.call(
          req.body,
          "orderAlertRecipient"
        );
        const normalizedOrderAlertRecipient =
          typeof req.body.orderAlertRecipient === "string"
            ? req.body.orderAlertRecipient.trim()
            : "";
        const nextOrderAlertRecipients = hasOrderAlertRecipient
          ? normalizedOrderAlertRecipient
            ? [normalizedOrderAlertRecipient]
            : []
          : Array.isArray(req.body.orderAlertRecipients)
            ? req.body.orderAlertRecipients
                .map((value) => String(value || "").trim())
                .filter(Boolean)
            : Array.isArray(currentBot.orderAlertRecipients)
              ? currentBot.orderAlertRecipients
              : [];

        const restaurant = await restaurantRepo.upsertRestaurant(req.restaurantId, {
          name: req.body.name.trim(),
          email: typeof req.body.email === "string" ? req.body.email.trim() : "",
          phone: typeof req.body.phone === "string" ? req.body.phone.trim() : "",
          address: typeof req.body.address === "string" ? req.body.address.trim() : "",
          timezone:
            typeof req.body.timezone === "string" && req.body.timezone.trim()
              ? req.body.timezone.trim()
              : String(currentRestaurant.timezone || "Africa/Lagos"),
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
            notifyOnPayment: true,
            customWelcomeMessage:
              typeof req.body.customWelcomeMessage === "string"
                ? req.body.customWelcomeMessage.trim()
                : String(currentBot.customWelcomeMessage || "").trim(),
            orderAlertRecipients: nextOrderAlertRecipients,
            paymentAlertRecipients: Array.isArray(req.body.paymentAlertRecipients)
              ? req.body.paymentAlertRecipients
                  .map((value) => String(value || "").trim())
                  .filter(Boolean)
              : Array.isArray(currentBot.paymentAlertRecipients)
                ? currentBot.paymentAlertRecipients
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
        if (restaurantOnboardingService) {
          await restaurantOnboardingService.syncRestaurantOnboardingProgress({
            restaurantId: req.restaurantId,
            actorId: req.user && req.user.uid ? req.user.uid : "settings",
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

  router.post(
    "/settings/order-alerts/test",
    requireApiKey(["settings.write"]),
    requireRestaurantAccess,
    async (req, res, next) => {
      try {
        if (!orderService || typeof orderService.sendRestaurantTestAlert !== "function") {
          throw new Error("Restaurant test alert service is not available");
        }

        const result = await orderService.sendRestaurantTestAlert({
          restaurantId: req.restaurantId,
          requestedBy: req.user && req.user.uid ? req.user.uid : "settings",
        });

        res.status(200).json({
          ok: true,
          ...result,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/settings/payment/banks",
    requireApiKey(["settings.read"]),
    requireRestaurantAccess,
    async (_req, res, next) => {
      try {
        if (!flutterwaveService || !flutterwaveService.isConfigured) {
          return res.status(503).json({
            error: "Automatic payment is not configured yet.",
          });
        }

        const banks = await flutterwaveService.listBanks();
        res.status(200).json({
          banks: banks.map((bank) => ({
            code: String(bank.code || ""),
            name: String(bank.name || ""),
          })),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/settings/payment/resolve-account",
    requireApiKey(["settings.write"]),
    requireRestaurantAccess,
    validateBody({
      bankCode: { type: "string", required: true },
      accountNumber: { type: "string", required: true },
    }),
    async (req, res, next) => {
      try {
        if (!flutterwaveService || !flutterwaveService.isConfigured) {
          return res.status(503).json({
            error: "Automatic payment is not configured yet.",
          });
        }

        const accountName = await flutterwaveService.resolveAccountName({
          bankCode: req.body.bankCode.trim(),
          accountNumber: req.body.accountNumber.trim(),
        });

        if (!accountName) {
          return res.status(422).json({
            error: "Could not resolve an account name for those details. Please double-check the bank and account number.",
          });
        }

        res.status(200).json({ accountName });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/settings/payment/automatic-setup",
    requireApiKey(["settings.write"]),
    requireRestaurantAccess,
    validateBody({
      bankCode: { type: "string", required: true },
      bankName: { type: "string", required: true },
      accountNumber: { type: "string", required: true },
      businessName: { type: "string", required: true },
    }),
    async (req, res, next) => {
      try {
        if (!flutterwaveService || !flutterwaveService.isConfigured) {
          return res.status(503).json({
            error: "Automatic payment is not configured yet.",
          });
        }

        const bankCode = req.body.bankCode.trim();
        const bankName = req.body.bankName.trim();
        const accountNumber = req.body.accountNumber.trim();
        const businessName = req.body.businessName.trim();
        const restaurant = req.restaurant || {};

        const accountName = await flutterwaveService.resolveAccountName({
          bankCode,
          accountNumber,
        });

        if (!accountName) {
          return res.status(422).json({
            error: "Could not verify that account number with the selected bank. Please double-check the details.",
          });
        }

        const subaccount = await flutterwaveService.createSubaccount({
          accountBank: bankCode,
          accountNumber,
          businessName,
          businessEmail: String(restaurant.email || "").trim() || "hello@servra.io",
          businessMobile: String(restaurant.phone || "").trim(),
          splitValue: 1,
        });

        const updated = await restaurantRepo.upsertRestaurant(req.restaurantId, {
          payment: {
            ...(restaurant.payment || {}),
            manualTransferEnabled: false,
            automatic: {
              enabled: true,
              bankCode,
              bankName,
              accountNumber,
              accountName,
              businessName,
              subaccountId: subaccount.subaccountId,
            },
          },
        });

        res.status(200).json({
          settings: serializeSettings(updated),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/settings/payment/automatic-toggle",
    requireApiKey(["settings.write"]),
    requireRestaurantAccess,
    validateBody({
      enabled: { type: "boolean", required: true },
    }),
    async (req, res, next) => {
      try {
        const restaurant = req.restaurant || {};
        const currentAutomatic = (restaurant.payment && restaurant.payment.automatic) || {};

        if (req.body.enabled && !currentAutomatic.subaccountId) {
          return res.status(409).json({
            error: "Set up your payout bank details before enabling automatic payment.",
          });
        }

        const updated = await restaurantRepo.upsertRestaurant(req.restaurantId, {
          payment: {
            ...(restaurant.payment || {}),
            manualTransferEnabled:
              req.body.enabled === true ? false : restaurant.payment?.manualTransferEnabled === true,
            automatic: {
              ...currentAutomatic,
              enabled: req.body.enabled === true,
            },
          },
        });

        res.status(200).json({
          settings: serializeSettings(updated),
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
