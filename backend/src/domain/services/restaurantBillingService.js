const BILLING_STATUSES = {
  TRIAL: "trial",
  TRIAL_EXPIRED: "trial_expired",
  PAYMENT_PENDING: "payment_pending",
  ACTIVE: "active",
  EXPIRED: "expired",
  LEGACY_ACTIVE: "legacy_active",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toIsoNow(now = new Date()) {
  return now.toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days) * MS_PER_DAY);
}

function createInitialBillingState(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const trialDays = Number(options.trialDays) > 0 ? Number(options.trialDays) : 15;

  return {
    status: BILLING_STATUSES.TRIAL,
    trialStartedAt: toIsoNow(now),
    trialEndsAt: addDays(now, trialDays).toISOString(),
    paymentReportedAt: null,
    paymentReportedBy: "",
    paymentApprovedAt: null,
    paymentApprovedBy: "",
    paymentRejectedAt: null,
    paymentRejectionReason: "",
    subscriptionEndsAt: null,
  };
}

function hasBillingRecord(restaurant = {}) {
  return Boolean(
    restaurant.billing && typeof restaurant.billing === "object" && restaurant.billing.status
  );
}

function resolveEffectiveStatus(billing = {}, now = new Date()) {
  const storedStatus = String(billing.status || "").trim().toLowerCase();

  if (storedStatus === BILLING_STATUSES.TRIAL) {
    const trialEndsAt = billing.trialEndsAt ? new Date(billing.trialEndsAt) : null;
    if (trialEndsAt && now >= trialEndsAt) {
      return BILLING_STATUSES.TRIAL_EXPIRED;
    }
    return BILLING_STATUSES.TRIAL;
  }

  if (storedStatus === BILLING_STATUSES.ACTIVE) {
    const subscriptionEndsAt = billing.subscriptionEndsAt
      ? new Date(billing.subscriptionEndsAt)
      : null;
    if (subscriptionEndsAt && now >= subscriptionEndsAt) {
      return BILLING_STATUSES.EXPIRED;
    }
    return BILLING_STATUSES.ACTIVE;
  }

  if (
    storedStatus === BILLING_STATUSES.TRIAL_EXPIRED ||
    storedStatus === BILLING_STATUSES.PAYMENT_PENDING ||
    storedStatus === BILLING_STATUSES.EXPIRED
  ) {
    return storedStatus;
  }

  return storedStatus || BILLING_STATUSES.LEGACY_ACTIVE;
}

function computeDaysRemaining(targetIso, now = new Date()) {
  if (!targetIso) {
    return null;
  }
  const target = new Date(targetIso);
  if (Number.isNaN(target.getTime())) {
    return null;
  }
  const diffMs = target.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / MS_PER_DAY));
}

function buildBotPausedMessage(restaurant = {}, effectiveStatus = "") {
  const restaurantName = String(restaurant.name || "This restaurant").trim();
  const phone = String(restaurant.phone || "").trim();

  if (effectiveStatus === BILLING_STATUSES.PAYMENT_PENDING) {
    return `${restaurantName} is temporarily unable to take WhatsApp orders while billing is being confirmed. Please try again soon${phone ? ` or call ${phone}` : ""}.`;
  }

  return `${restaurantName} is temporarily unable to take WhatsApp orders right now. Please contact them directly${phone ? ` at ${phone}` : ""} or try again later.`;
}

function buildBillingSnapshot(restaurant = {}, config = {}) {
  const now = config.now instanceof Date ? config.now : new Date();

  if (!hasBillingRecord(restaurant)) {
    return {
      status: BILLING_STATUSES.LEGACY_ACTIVE,
      effectiveStatus: BILLING_STATUSES.LEGACY_ACTIVE,
      botAllowed: true,
      portalAllowed: true,
      canReportPayment: false,
      daysRemaining: null,
      trialEndsAt: null,
      subscriptionEndsAt: null,
      paymentReportedAt: null,
      paymentApprovedAt: null,
      paymentRejectedAt: null,
      paymentRejectionReason: "",
      botPausedMessage: "",
      paymentInstructions: null,
      legacy: true,
    };
  }

  const billing = restaurant.billing;
  const effectiveStatus = resolveEffectiveStatus(billing, now);
  const botAllowed =
    effectiveStatus === BILLING_STATUSES.TRIAL ||
    effectiveStatus === BILLING_STATUSES.ACTIVE ||
    effectiveStatus === BILLING_STATUSES.LEGACY_ACTIVE;

  const canReportPayment =
    effectiveStatus === BILLING_STATUSES.TRIAL_EXPIRED ||
    effectiveStatus === BILLING_STATUSES.EXPIRED ||
    (effectiveStatus === BILLING_STATUSES.TRIAL &&
      computeDaysRemaining(billing.trialEndsAt, now) <= 3);

  const daysRemaining =
    effectiveStatus === BILLING_STATUSES.TRIAL
      ? computeDaysRemaining(billing.trialEndsAt, now)
      : effectiveStatus === BILLING_STATUSES.ACTIVE
        ? computeDaysRemaining(billing.subscriptionEndsAt, now)
        : null;

  return {
    status: billing.status,
    effectiveStatus,
    botAllowed,
    portalAllowed: true,
    canReportPayment:
      canReportPayment && effectiveStatus !== BILLING_STATUSES.PAYMENT_PENDING,
    daysRemaining,
    trialStartedAt: billing.trialStartedAt || null,
    trialEndsAt: billing.trialEndsAt || null,
    subscriptionEndsAt: billing.subscriptionEndsAt || null,
    paymentReportedAt: billing.paymentReportedAt || null,
    paymentReportedBy: billing.paymentReportedBy || "",
    paymentApprovedAt: billing.paymentApprovedAt || null,
    paymentApprovedBy: billing.paymentApprovedBy || "",
    paymentRejectedAt: billing.paymentRejectedAt || null,
    paymentRejectionReason: billing.paymentRejectionReason || "",
    botPausedMessage: botAllowed ? "" : buildBotPausedMessage(restaurant, effectiveStatus),
    paymentInstructions: config.paymentInstructions || null,
    legacy: false,
  };
}

function getBotAccess(restaurant = {}, config = {}) {
  const snapshot = buildBillingSnapshot(restaurant, config);
  return {
    allowed: snapshot.botAllowed,
    reason: snapshot.effectiveStatus,
    message: snapshot.botPausedMessage,
  };
}

function createRestaurantBillingService({ restaurantRepo, env = {} }) {
  const trialDays = Number(env.RESTAURANT_TRIAL_DAYS) > 0 ? Number(env.RESTAURANT_TRIAL_DAYS) : 15;
  const paidPeriodDays =
    Number(env.RESTAURANT_PAID_PERIOD_DAYS) > 0 ? Number(env.RESTAURANT_PAID_PERIOD_DAYS) : 30;

  function getPaymentInstructions() {
    const bankName = String(env.SERVRA_BILLING_BANK_NAME || "").trim();
    const accountName = String(env.SERVRA_BILLING_ACCOUNT_NAME || "").trim();
    const accountNumber = String(env.SERVRA_BILLING_ACCOUNT_NUMBER || "").trim();
    const amount = Number(env.SERVRA_BILLING_AMOUNT) || null;
    const contactEmail = String(env.SERVRA_BILLING_CONTACT_EMAIL || "hello@servra.io").trim();

    if (!bankName && !accountNumber) {
      return {
        contactEmail,
        amount,
        note: `Contact ${contactEmail} for payment details.`,
      };
    }

    return {
      bankName,
      accountName,
      accountNumber,
      amount,
      currency: String(env.SERVRA_BILLING_CURRENCY || "NGN").trim(),
      contactEmail,
    };
  }

  function getConfig(options = {}) {
    return {
      now: options.now,
      trialDays,
      paidPeriodDays,
      paymentInstructions: getPaymentInstructions(),
    };
  }

  async function syncStoredStatus(restaurantId, restaurant = null) {
    const record = restaurant || (await restaurantRepo.getRestaurantById(restaurantId));
    if (!record || !hasBillingRecord(record)) {
      return record;
    }

    const now = new Date();
    const effectiveStatus = resolveEffectiveStatus(record.billing, now);
    const storedStatus = String(record.billing.status || "").trim().toLowerCase();
    let nextStatus = storedStatus;

    if (storedStatus === BILLING_STATUSES.TRIAL && effectiveStatus === BILLING_STATUSES.TRIAL_EXPIRED) {
      nextStatus = BILLING_STATUSES.TRIAL_EXPIRED;
    } else if (
      storedStatus === BILLING_STATUSES.ACTIVE &&
      effectiveStatus === BILLING_STATUSES.EXPIRED
    ) {
      nextStatus = BILLING_STATUSES.EXPIRED;
    }

    if (nextStatus === storedStatus) {
      return record;
    }

    return restaurantRepo.upsertRestaurant(restaurantId, {
      billing: {
        ...record.billing,
        status: nextStatus,
        statusUpdatedAt: toIsoNow(now),
      },
    });
  }

  async function getBillingStatus(restaurantId) {
    const restaurant = await syncStoredStatus(restaurantId);
    if (!restaurant) {
      const error = new Error("Restaurant not found");
      error.statusCode = 404;
      throw error;
    }

    return {
      restaurantId,
      restaurantName: restaurant.name || "",
      billing: buildBillingSnapshot(restaurant, getConfig()),
    };
  }

  async function reportPayment({ restaurantId, reportedBy = "" }) {
    const restaurant = await syncStoredStatus(restaurantId);
    if (!restaurant) {
      const error = new Error("Restaurant not found");
      error.statusCode = 404;
      throw error;
    }

    const snapshot = buildBillingSnapshot(restaurant, getConfig());
    if (!snapshot.canReportPayment && snapshot.effectiveStatus !== BILLING_STATUSES.TRIAL_EXPIRED && snapshot.effectiveStatus !== BILLING_STATUSES.EXPIRED) {
      const error = new Error("Payment cannot be reported for the current billing state.");
      error.statusCode = 409;
      throw error;
    }

    if (snapshot.effectiveStatus === BILLING_STATUSES.PAYMENT_PENDING) {
      const error = new Error("Payment is already awaiting admin approval.");
      error.statusCode = 409;
      throw error;
    }

    const now = toIsoNow();
    const updated = await restaurantRepo.upsertRestaurant(restaurantId, {
      billing: {
        ...(restaurant.billing || {}),
        status: BILLING_STATUSES.PAYMENT_PENDING,
        paymentReportedAt: now,
        paymentReportedBy: String(reportedBy || "").trim(),
        paymentRejectedAt: null,
        paymentRejectionReason: "",
        statusUpdatedAt: now,
      },
    });

    return buildBillingSnapshot(updated, getConfig());
  }

  async function approvePayment({ restaurantId, approvedBy = "", note = "" }) {
    const restaurant = await syncStoredStatus(restaurantId);
    if (!restaurant) {
      const error = new Error("Restaurant not found");
      error.statusCode = 404;
      throw error;
    }

    const snapshot = buildBillingSnapshot(restaurant, getConfig());
    if (snapshot.effectiveStatus !== BILLING_STATUSES.PAYMENT_PENDING) {
      const error = new Error("Restaurant does not have a pending payment to approve.");
      error.statusCode = 409;
      throw error;
    }

    const now = new Date();
    const subscriptionEndsAt = addDays(now, paidPeriodDays).toISOString();
    const updated = await restaurantRepo.upsertRestaurant(restaurantId, {
      plan: restaurant.plan || "Standard",
      billing: {
        ...(restaurant.billing || {}),
        status: BILLING_STATUSES.ACTIVE,
        paymentApprovedAt: toIsoNow(now),
        paymentApprovedBy: String(approvedBy || "").trim(),
        paymentApprovalNote: String(note || "").trim(),
        subscriptionEndsAt,
        paymentRejectedAt: null,
        paymentRejectionReason: "",
        statusUpdatedAt: toIsoNow(now),
      },
    });

    return buildBillingSnapshot(updated, getConfig());
  }

  async function rejectPayment({ restaurantId, rejectedBy = "", reason = "" }) {
    const restaurant = await syncStoredStatus(restaurantId);
    if (!restaurant) {
      const error = new Error("Restaurant not found");
      error.statusCode = 404;
      throw error;
    }

    const snapshot = buildBillingSnapshot(restaurant, getConfig());
    if (snapshot.effectiveStatus !== BILLING_STATUSES.PAYMENT_PENDING) {
      const error = new Error("Restaurant does not have a pending payment to reject.");
      error.statusCode = 409;
      throw error;
    }

    const now = toIsoNow();
    const fallbackStatus =
      restaurant.billing && restaurant.billing.trialEndsAt
        ? BILLING_STATUSES.TRIAL_EXPIRED
        : BILLING_STATUSES.EXPIRED;

    const updated = await restaurantRepo.upsertRestaurant(restaurantId, {
      billing: {
        ...(restaurant.billing || {}),
        status: fallbackStatus,
        paymentRejectedAt: now,
        paymentRejectionReason: String(reason || "Payment could not be verified.").trim(),
        paymentRejectedBy: String(rejectedBy || "").trim(),
        statusUpdatedAt: now,
      },
    });

    return buildBillingSnapshot(updated, getConfig());
  }

  async function confirmAutomaticPayment({ restaurantId, provider, transactionId, amount, currency, txRef }) {
    const restaurant = await syncStoredStatus(restaurantId);
    if (!restaurant) {
      const error = new Error("Restaurant not found");
      error.statusCode = 404;
      throw error;
    }

    const now = new Date();
    const currentBilling = restaurant.billing || {};
    const currentEndsAt = currentBilling.subscriptionEndsAt
      ? new Date(currentBilling.subscriptionEndsAt)
      : null;
    const renewalBase = currentEndsAt && currentEndsAt > now ? currentEndsAt : now;
    const subscriptionEndsAt = addDays(renewalBase, paidPeriodDays).toISOString();

    const updated = await restaurantRepo.upsertRestaurant(restaurantId, {
      plan: restaurant.plan || "Standard",
      billing: {
        ...currentBilling,
        status: BILLING_STATUSES.ACTIVE,
        paymentApprovedAt: toIsoNow(now),
        paymentApprovedBy: `auto:${provider}`,
        paymentApprovalNote: `Automatic payment via ${provider}`,
        subscriptionEndsAt,
        paymentRejectedAt: null,
        paymentRejectionReason: "",
        lastPaymentProvider: provider,
        lastPaymentTransactionId: String(transactionId || ""),
        lastPaymentReference: String(txRef || ""),
        lastPaymentAmount: Number(amount) || null,
        lastPaymentCurrency: String(currency || ""),
        statusUpdatedAt: toIsoNow(now),
      },
    });

    return buildBillingSnapshot(updated, getConfig());
  }

  async function listPendingApprovals(options = {}) {
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 100;
    const restaurants = await restaurantRepo.listRestaurants({ limit: 200 });
    const pending = [];

    for (const restaurant of restaurants) {
      const synced = await syncStoredStatus(restaurant.id, restaurant);
      const snapshot = buildBillingSnapshot(synced, getConfig());
      if (
        snapshot.effectiveStatus === BILLING_STATUSES.PAYMENT_PENDING ||
        snapshot.effectiveStatus === BILLING_STATUSES.TRIAL_EXPIRED ||
        snapshot.effectiveStatus === BILLING_STATUSES.EXPIRED
      ) {
        pending.push({
          restaurantId: synced.id,
          restaurantName: synced.name || "",
          email: synced.email || "",
          phone: synced.phone || "",
          billing: snapshot,
        });
      }
    }

    return pending.slice(0, limit);
  }

  return {
    BILLING_STATUSES,
    createInitialBillingState,
    buildBillingSnapshot,
    getBotAccess,
    getPaymentInstructions,
    syncStoredStatus,
    getBillingStatus,
    reportPayment,
    approvePayment,
    rejectPayment,
    confirmAutomaticPayment,
    listPendingApprovals,
  };
}

module.exports = {
  BILLING_STATUSES,
  createInitialBillingState,
  resolveEffectiveStatus,
  buildBillingSnapshot,
  getBotAccess,
  createRestaurantBillingService,
};
