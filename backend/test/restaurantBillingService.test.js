const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BILLING_STATUSES,
  createInitialBillingState,
  resolveEffectiveStatus,
  buildBillingSnapshot,
  getBotAccess,
} = require("../src/domain/services/restaurantBillingService");

test("createInitialBillingState starts a 15-day trial", () => {
  const now = new Date("2026-06-01T10:00:00.000Z");
  const billing = createInitialBillingState({ now, trialDays: 15 });

  assert.equal(billing.status, BILLING_STATUSES.TRIAL);
  assert.equal(billing.trialStartedAt, now.toISOString());
  assert.equal(billing.trialEndsAt, "2026-06-16T10:00:00.000Z");
});

test("resolveEffectiveStatus moves trial to trial_expired after end date", () => {
  const billing = createInitialBillingState({
    now: new Date("2026-06-01T10:00:00.000Z"),
    trialDays: 15,
  });

  assert.equal(
    resolveEffectiveStatus(billing, new Date("2026-06-16T10:00:00.000Z")),
    BILLING_STATUSES.TRIAL_EXPIRED
  );
});

test("buildBillingSnapshot allows bot during trial and active periods", () => {
  const trialRestaurant = {
    name: "Demo Kitchen",
    billing: createInitialBillingState({
      now: new Date("2026-06-01T10:00:00.000Z"),
      trialDays: 15,
    }),
  };

  const trialSnapshot = buildBillingSnapshot(trialRestaurant, {
    now: new Date("2026-06-05T10:00:00.000Z"),
  });
  assert.equal(trialSnapshot.botAllowed, true);

  const expiredRestaurant = {
    name: "Demo Kitchen",
    billing: {
      ...trialRestaurant.billing,
      status: BILLING_STATUSES.TRIAL_EXPIRED,
    },
  };
  const expiredSnapshot = buildBillingSnapshot(expiredRestaurant);
  assert.equal(expiredSnapshot.botAllowed, false);
  assert.match(expiredSnapshot.botPausedMessage, /temporarily unable to take WhatsApp orders/i);
});

test("getBotAccess keeps legacy restaurants active", () => {
  const access = getBotAccess({ name: "Legacy Spot" });
  assert.equal(access.allowed, true);
});

test("buildBillingSnapshot allows payment report when trial expired", () => {
  const restaurant = {
    billing: {
      status: BILLING_STATUSES.TRIAL_EXPIRED,
      trialEndsAt: "2026-06-01T10:00:00.000Z",
    },
  };

  const snapshot = buildBillingSnapshot(restaurant);
  assert.equal(snapshot.canReportPayment, true);
  assert.equal(snapshot.effectiveStatus, BILLING_STATUSES.TRIAL_EXPIRED);
});
