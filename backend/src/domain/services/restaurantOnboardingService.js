const { ROLES, getDefaultPermissionsForRole } = require("../../auth/permissions");

function slugifyRestaurantId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "restaurant";
}

async function buildUniqueRestaurantId(preferredId, restaurantName, restaurantRepo) {
  const baseId = slugifyRestaurantId(preferredId || restaurantName);
  let candidate = baseId;
  let counter = 2;

  while (await restaurantRepo.getRestaurantById(candidate)) {
    candidate = `${baseId}_${counter}`;
    counter += 1;
  }

  return candidate;
}

function createSampleMenuItems(restaurantName) {
  const safeName = String(restaurantName || "Restaurant").trim();
  return [
    {
      name: `${safeName} Rice Bowl`,
      category: "Main",
      price: 3500,
      available: true,
    },
    {
      name: `${safeName} Signature Drink`,
      category: "Drinks",
      price: 1200,
      available: true,
    },
  ];
}

function createInitialOnboardingState({ source = "self_serve_signup", actorId = "" } = {}) {
  const now = new Date().toISOString();

  return {
    status: "in_progress",
    source,
    currentStep: "profile",
    completedSteps: ["account"],
    startedAt: now,
    completedAt: null,
    lastCompletedAt: now,
    updatedAt: now,
    updatedBy: actorId || source,
  };
}

function normalizeOnboardingState(onboarding = {}) {
  const safeOnboarding =
    onboarding && typeof onboarding === "object" ? onboarding : {};
  const completedSteps = Array.isArray(safeOnboarding.completedSteps)
    ? safeOnboarding.completedSteps
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    : [];

  const dedupedCompletedSteps = Array.from(new Set(completedSteps));

  return {
    status:
      String(safeOnboarding.status || "not_started").trim().toLowerCase() ||
      "not_started",
    source: String(safeOnboarding.source || "").trim(),
    currentStep:
      String(safeOnboarding.currentStep || "").trim().toLowerCase() || "",
    completedSteps: dedupedCompletedSteps,
    startedAt: safeOnboarding.startedAt || null,
    completedAt: safeOnboarding.completedAt || null,
    lastCompletedAt: safeOnboarding.lastCompletedAt || null,
    updatedAt: safeOnboarding.updatedAt || null,
    updatedBy: String(safeOnboarding.updatedBy || "").trim(),
  };
}

function isProfileComplete(restaurant = {}) {
  return Boolean(
    String(restaurant.name || "").trim() &&
      String(restaurant.phone || "").trim() &&
      String(restaurant.address || "").trim()
  );
}

function isHoursComplete(restaurant = {}) {
  return Boolean(
    String(restaurant.openingHours || "").trim() && String(restaurant.closingHours || "").trim()
  );
}

function isSettingsComplete(restaurant = {}) {
  return Boolean(
    restaurant.acceptOrders === true &&
    restaurant.notifyOnOrder === true &&
    restaurant.manualTransferEnabled === true &&
    String(restaurant.bankName || "").trim() &&
    String(restaurant.accountName || "").trim() &&
    String(restaurant.accountNumber || "").trim() &&
    String(restaurant.orderAlertRecipients || "").trim()
  );
}

function buildChecklistProgress({ restaurant, menuItems, deliveryZones, whatsapp }) {
  const checks = [
    {
      id: "account",
      label: "Account created",
      complete: true,
      href: "/profile",
    },
    {
      id: "profile",
      label: "Restaurant profile",
      complete: isProfileComplete(restaurant),
      href: "/settings",
    },
    {
      id: "hours",
      label: "Opening hours",
      complete: isHoursComplete(restaurant),
      href: "/settings",
    },
    {
      id: "menu",
      label: "First menu item",
      complete: Array.isArray(menuItems) && menuItems.length > 0,
      href: "/menu",
    },
    {
      id: "delivery",
      label: "Delivery zone",
      complete: Array.isArray(deliveryZones) && deliveryZones.length > 0,
      href: "/delivery",
    },
    {
      id: "whatsapp",
      label: "WhatsApp connection",
      complete: Boolean(whatsapp && whatsapp.configured),
      href: "/whatsapp",
    },
    {
      id: "settings",
      label: "Order & Payment Settings",
      complete: isSettingsComplete(restaurant),
      href: "/settings",
    },
    {
      id: "subscription",
      label: "Select subscription plan",
      complete: Boolean(restaurant?.plan && restaurant.plan !== null),
      href: "/subscription",
    },
  ];

  const requiredStepIds = ["profile", "hours", "menu", "whatsapp", "settings", "subscription"];
  const requiredComplete = requiredStepIds.every((stepId) =>
    checks.some((item) => item.id === stepId && item.complete)
  );
  const completedCount = checks.filter((item) => item.complete).length;
  const firstIncomplete = checks.find((item) => !item.complete);

  return {
    checks,
    completedCount,
    totalCount: checks.length,
    requiredComplete,
    currentStep: firstIncomplete ? firstIncomplete.id : "done",
    completedSteps: checks.filter((item) => item.complete).map((item) => item.id),
  };
}

function createRestaurantOnboardingService({
  admin,
  restaurantRepo,
  userRepo,
  menuRepo,
  deliveryZoneRepo,
  providerSessionRepo,
  resolveWhatsappChannelStatus,
  env,
  restaurantHealthService,
}) {
  async function createRestaurantWorkspace({
    restaurantName,
    adminEmail,
    adminPassword,
    adminDisplayName,
    restaurantId,
    phone = "",
    address = "",
    timezone = "Africa/Lagos",
    openingHours = "08:00",
    closingHours = "22:00",
    seedSampleMenu = false,
    createdBy = "",
    source = "self_serve_signup",
  }) {
    const normalizedRestaurantName = String(restaurantName || "").trim();
    const normalizedAdminEmail = String(adminEmail || "").trim().toLowerCase();
    const normalizedAdminPassword = String(adminPassword || "");
    const resolvedRestaurantId = await buildUniqueRestaurantId(
      restaurantId,
      normalizedRestaurantName,
      restaurantRepo
    );
    const resolvedAdminDisplayName =
      String(adminDisplayName || "").trim() || `${normalizedRestaurantName} Admin`;
    const actorId = String(createdBy || source || "system").trim();

    let authUser;
    try {
      authUser = await admin.auth().createUser({
        email: normalizedAdminEmail,
        password: normalizedAdminPassword,
        displayName: resolvedAdminDisplayName,
        disabled: false,
      });
    } catch (error) {
      if (error && error.code === "auth/email-already-exists") {
        const conflict = new Error("A portal user with that admin email already exists.");
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    }

    try {
      const restaurant = await restaurantRepo.upsertRestaurant(resolvedRestaurantId, {
        name: normalizedRestaurantName,
        email: normalizedAdminEmail,
        phone: String(phone || "").trim(),
        address: String(address || "").trim(),
        timezone: String(timezone || "Africa/Lagos").trim(),
        plan: null,
        openingHours: String(openingHours || "08:00").trim(),
        closingHours: String(closingHours || "22:00").trim(),
        bot: {
          enabled: true,
          autoConfirm: false,
          notifyOnOrder: true,
        },
        onboarding: createInitialOnboardingState({
          source,
          actorId,
        }),
        activation: {
          state: "draft",
          note: "Restaurant created and waiting for configuration.",
          updatedBy: actorId,
          updatedAt: new Date().toISOString(),
        },
        createdBy: actorId,
        whatsapp: {
          configured: false,
          provider: "",
          provisioningState: "unassigned",
          phone: "",
          phoneNumberId: "",
          wabaId: "",
        },
      });

      const adminProfile = await userRepo.upsertUser(authUser.uid, {
        email: normalizedAdminEmail,
        displayName: resolvedAdminDisplayName,
        role: ROLES.RESTAURANT_ADMIN,
        restaurantId: resolvedRestaurantId,
        permissions: getDefaultPermissionsForRole(ROLES.RESTAURANT_ADMIN),
        isActive: true,
      });

      let seededMenuCount = 0;
      if (seedSampleMenu === true) {
        const sampleMenu = createSampleMenuItems(normalizedRestaurantName);
        for (const item of sampleMenu) {
          await menuRepo.createMenuItem(resolvedRestaurantId, item);
        }
        seededMenuCount = sampleMenu.length;
      }

      if (restaurantHealthService) {
        await restaurantHealthService.evaluateAndPersistRestaurantHealth({
          restaurantId: resolvedRestaurantId,
          source: "restaurant_onboarded",
        });
      }

      return {
        restaurant,
        adminUser: {
          uid: adminProfile.uid,
          email: adminProfile.email,
          displayName: adminProfile.displayName,
          role: adminProfile.role,
          restaurantId: adminProfile.restaurantId,
        },
        onboarding: {
          ...normalizeOnboardingState(restaurant.onboarding),
          seededMenuCount,
        },
      };
    } catch (error) {
      try {
        await admin.auth().deleteUser(authUser.uid);
      } catch (_cleanupError) {
        // Best effort cleanup for partially created auth users.
      }
      throw error;
    }
  }

  async function syncRestaurantOnboardingProgress({ restaurantId, actorId = "" }) {
    const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
    if (!restaurant) {
      return null;
    }

    const [menuItems, deliveryZones, session] = await Promise.all([
      menuRepo.listMenuItems(restaurantId),
      deliveryZoneRepo.listDeliveryZones(restaurantId),
      providerSessionRepo.getSession(restaurantId, "whatsapp-web"),
    ]);
    const whatsapp = resolveWhatsappChannelStatus({
      restaurant,
      restaurantId,
      session,
      env,
    });
    const existing = normalizeOnboardingState(restaurant.onboarding);
    const progress = buildChecklistProgress({
      restaurant,
      menuItems,
      deliveryZones,
      whatsapp,
    });
    const now = new Date().toISOString();

    const updatedRestaurant = await restaurantRepo.upsertRestaurant(restaurantId, {
      onboarding: {
        ...(restaurant.onboarding && typeof restaurant.onboarding === "object"
          ? restaurant.onboarding
          : {}),
        status: existing.status === "completed" ? "completed" : "in_progress",
        source: existing.source || "self_serve_signup",
        currentStep: progress.currentStep,
        completedSteps: progress.completedSteps,
        startedAt: existing.startedAt || now,
        completedAt: existing.completedAt || null,
        lastCompletedAt: progress.completedSteps.length ? now : existing.lastCompletedAt || null,
        updatedAt: now,
        updatedBy: String(actorId || existing.updatedBy || "system").trim() || "system",
      },
    });

    return {
      restaurant: updatedRestaurant,
      onboarding: {
        ...normalizeOnboardingState(updatedRestaurant.onboarding),
        progress,
      },
      whatsapp,
    };
  }

  return {
    buildChecklistProgress,
    createRestaurantWorkspace,
    normalizeOnboardingState,
    syncRestaurantOnboardingProgress,
  };
}

module.exports = {
  buildUniqueRestaurantId,
  buildChecklistProgress,
  createRestaurantOnboardingService,
  createSampleMenuItems,
  normalizeOnboardingState,
  slugifyRestaurantId,
};
