const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildChecklistProgress,
  isPaymentComplete,
} = require("../src/domain/services/restaurantOnboardingService");

test("isPaymentComplete reads nested payment settings", () => {
  assert.equal(
    isPaymentComplete({
      payment: {
        manualTransferEnabled: true,
        bankName: "GTBank",
        accountName: "Servra Kitchen",
        accountNumber: "0123456789",
      },
    }),
    true
  );

  assert.equal(
    isPaymentComplete({
      manualTransferEnabled: true,
      bankName: "GTBank",
      accountName: "Servra Kitchen",
      accountNumber: "0123456789",
    }),
    false
  );
});

test("buildChecklistProgress no longer requires subscription", () => {
  const progress = buildChecklistProgress({
    restaurant: {
      name: "Servra",
      phone: "08012345678",
      address: "Lagos",
      openingHours: "08:00",
      closingHours: "22:00",
      payment: {
        manualTransferEnabled: true,
        bankName: "GTBank",
        accountName: "Servra Kitchen",
        accountNumber: "0123456789",
      },
    },
    menuItems: [{ id: "1" }],
    deliveryZones: [],
    whatsapp: { configured: true },
  });

  assert.equal(
    progress.checks.some((item) => item.id === "subscription"),
    false
  );
  assert.equal(progress.requiredComplete, true);
  assert.equal(
    progress.checks.find((item) => item.id === "payment")?.href,
    "/payments"
  );
});
