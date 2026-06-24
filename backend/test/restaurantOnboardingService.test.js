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


test("createRestaurantWorkspace sends activation link instead of a password", async () => {
  const createdUsers = [];
  const sentEmails = [];

  const { createRestaurantOnboardingService } = require("../src/domain/services/restaurantOnboardingService");

  const service = createRestaurantOnboardingService({
    admin: {
      auth: () => ({
        createUser: async (payload) => {
          createdUsers.push(payload);
          return { uid: "auth_uid_123" };
        },
        deleteUser: async () => {},
      }),
    },
    restaurantRepo: {
      getRestaurantById: async () => null,
      upsertRestaurant: async (_restaurantId, data) => ({ id: "lead_mall", onboarding: data.onboarding || {}, ...data }),
    },
    userRepo: {
      upsertUser: async (uid, data) => ({ uid, ...data }),
    },
    menuRepo: {
      createMenuItem: async () => {},
      listMenuItems: async () => [],
    },
    deliveryZoneRepo: {
      listDeliveryZones: async () => [],
    },
    providerSessionRepo: {
      getSession: async () => null,
    },
    resolveWhatsappChannelStatus: () => ({ configured: false }),
    env: {
      PORTAL_APP_URL: "https://portal.example.com",
    },
    restaurantHealthService: {
      evaluateAndPersistRestaurantHealth: async () => {},
    },
    sendRestaurantActivationEmail: async (payload) => {
      sentEmails.push(payload);
    },
  });

  const created = await service.createRestaurantWorkspace({
    restaurantName: "Lead Mall",
    adminEmail: "owner@example.com",
    adminDisplayName: "Lead Mall Owner",
    sendActivationEmail: true,
    createdBy: "super_admin_1",
    source: "admin_onboarding",
  });

  assert.equal(createdUsers.length, 1);
  assert.deepEqual(createdUsers[0], {
    email: "owner@example.com",
    displayName: "Lead Mall Owner",
    disabled: false,
  });
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].email, "owner@example.com");
  assert.equal(sentEmails[0].displayName, "Lead Mall Owner");
  assert.equal(sentEmails[0].restaurantName, "Lead Mall");
  assert.equal(created.portalAccess.activationLink, undefined);
  assert.equal(created.portalAccess.activationEmailSent, true);
});
