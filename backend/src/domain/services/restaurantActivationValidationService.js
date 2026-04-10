function parseTimeValue(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

function createSection({ key, label, status, severity, detail, issues = [] }) {
  return {
    key,
    label,
    status,
    severity,
    detail,
    issues,
  };
}

const CHECK_ACTIONS = {
  profile: {
    label: "Complete restaurant profile",
    path: "settings",
  },
  admin: {
    label: "Assign restaurant admin",
    path: "detail",
  },
  hours: {
    label: "Set operating hours",
    path: "settings",
  },
  menu: {
    label: "Upload menu items",
    path: "menu",
  },
  whatsapp: {
    label: "Finish WhatsApp setup",
    path: "whatsapp",
  },
};

const LIFECYCLE_ORDER = [
  "draft",
  "configured",
  "ready_for_activation",
  "activating",
  "active",
];

const TRANSITION_RULES = {
  draft: {
    draft: [],
    configured: ["profile", "admin"],
    ready_for_activation: ["profile", "admin", "hours", "menu", "whatsapp"],
    active: ["profile", "admin", "hours", "menu", "whatsapp"],
  },
  configured: {
    configured: [],
    ready_for_activation: ["profile", "admin", "hours", "menu", "whatsapp"],
    active: ["profile", "admin", "hours", "menu", "whatsapp"],
    draft: [],
  },
  ready_for_activation: {
    ready_for_activation: [],
    activating: ["profile", "admin", "hours", "menu", "whatsapp"],
    active: ["profile", "admin", "hours", "menu", "whatsapp"],
    configured: [],
    draft: [],
  },
  activating: {
    activating: [],
    active: [],
    ready_for_activation: [],
  },
  active: {
    active: [],
    ready_for_activation: [],
    configured: [],
    draft: [],
  },
};

function buildRestaurantActivationValidation({
  restaurant,
  adminUser,
  menuItems = [],
  whatsapp = null,
}) {
  const safeRestaurant = restaurant && typeof restaurant === "object" ? restaurant : {};
  const name = String(safeRestaurant.name || "").trim();
  const phone = String(safeRestaurant.phone || "").trim();
  const address = String(safeRestaurant.address || "").trim();
  const openingHours = String(safeRestaurant.openingHours || "").trim();
  const closingHours = String(safeRestaurant.closingHours || "").trim();
  const availableMenuItems = (menuItems || []).filter((item) => item && item.available !== false);

  const sections = {};

  const profileIssues = [];
  if (!name) {
    profileIssues.push("Restaurant name is missing.");
  }
  if (!phone) {
    profileIssues.push("Restaurant phone is missing.");
  }
  if (!address) {
    profileIssues.push("Restaurant address is missing.");
  }
  sections.profile = createSection({
    key: "profile",
    label: "Restaurant profile",
    status: profileIssues.length ? "invalid" : "valid",
    severity: profileIssues.length ? "blocker" : "ok",
    detail: profileIssues.length
      ? "Basic restaurant profile still needs attention."
      : "Name, phone, and address are filled.",
    issues: profileIssues,
  });

  const adminIssues = [];
  if (!adminUser || !String(adminUser.email || "").trim()) {
    adminIssues.push("No restaurant admin account is assigned.");
  }
  sections.admin = createSection({
    key: "admin",
    label: "Admin account",
    status: adminIssues.length ? "invalid" : "valid",
    severity: adminIssues.length ? "blocker" : "ok",
    detail: adminIssues.length
      ? "A restaurant admin still needs to be assigned."
      : "A restaurant admin account exists.",
    issues: adminIssues,
  });

  const hoursIssues = [];
  const openMinutes = parseTimeValue(openingHours);
  const closeMinutes = parseTimeValue(closingHours);
  if (!openingHours || !closingHours) {
    hoursIssues.push("Opening and closing hours must both be set.");
  } else if (openMinutes === null || closeMinutes === null) {
    hoursIssues.push("Operating hours must use HH:MM format.");
  } else if (openMinutes === closeMinutes) {
    hoursIssues.push("Opening and closing hours cannot be the same.");
  }
  sections.hours = createSection({
    key: "hours",
    label: "Operating hours",
    status: hoursIssues.length ? "invalid" : "valid",
    severity: hoursIssues.length ? "blocker" : "ok",
    detail: hoursIssues.length
      ? "Operating hours are not ready yet."
      : `Open ${openingHours} - ${closingHours}.`,
    issues: hoursIssues,
  });

  const menuIssues = [];
  const menuWarnings = [];
  if (!availableMenuItems.length) {
    menuIssues.push("At least one available menu item is required.");
  }
  if (
    availableMenuItems.length &&
    availableMenuItems.every((item) => !String(item.category || "").trim())
  ) {
    menuWarnings.push("Menu items do not have categories yet.");
  }
  sections.menu = createSection({
    key: "menu",
    label: "Menu readiness",
    status: menuIssues.length ? "invalid" : menuWarnings.length ? "warning" : "valid",
    severity: menuIssues.length ? "blocker" : menuWarnings.length ? "warning" : "ok",
    detail: menuIssues.length
      ? "The menu is not ready for customers yet."
      : availableMenuItems.length
        ? `${availableMenuItems.length} available item(s) are ready.`
        : "Menu needs more work.",
    issues: [...menuIssues, ...menuWarnings],
  });

  const whatsappIssues = [];
  const whatsappWarnings = [];
  const provider = String(whatsapp && whatsapp.provider ? whatsapp.provider : "").trim().toLowerCase();
  const configured = Boolean(whatsapp && whatsapp.configured);
  const boundPhone = String(whatsapp && whatsapp.phone ? whatsapp.phone : "").trim();
  const phoneNumberId = String(
    whatsapp && whatsapp.phoneNumberId ? whatsapp.phoneNumberId : ""
  ).trim();
  const wabaId = String(whatsapp && whatsapp.wabaId ? whatsapp.wabaId : "").trim();
  const provisioningState = String(
    whatsapp && whatsapp.provisioningState ? whatsapp.provisioningState : ""
  )
    .trim()
    .toLowerCase();
  const activationReady = Boolean(whatsapp && whatsapp.activationReady);

  if (!configured) {
    whatsappIssues.push("WhatsApp is not configured for this restaurant.");
  }
  if (configured && !boundPhone) {
    whatsappIssues.push("WhatsApp display phone is missing.");
  }
  if (configured && !activationReady) {
    whatsappIssues.push(
      provisioningState
        ? `WhatsApp provisioning is still ${provisioningState} and must reach verified or active before go-live.`
        : "WhatsApp provisioning must be verified before go-live."
    );
  }
  if (configured && provider === "meta-whatsapp-cloud-api" && !phoneNumberId) {
    whatsappWarnings.push("Meta phone number ID has not been saved yet.");
  }
  if (configured && provider === "meta-whatsapp-cloud-api" && !wabaId) {
    whatsappWarnings.push("Meta WABA ID has not been saved yet.");
  }
  sections.whatsapp = createSection({
    key: "whatsapp",
    label: "WhatsApp setup",
    status: whatsappIssues.length ? "invalid" : whatsappWarnings.length ? "warning" : "valid",
    severity: whatsappIssues.length ? "blocker" : whatsappWarnings.length ? "warning" : "ok",
    detail: whatsapp && whatsapp.setupMessage
      ? whatsapp.setupMessage
      : configured
        ? activationReady
          ? "WhatsApp line is provisioned and ready."
          : "WhatsApp line is configured but still not fully provisioned."
        : "WhatsApp still needs configuration.",
    issues: [...whatsappIssues, ...whatsappWarnings],
  });

  const orderedSections = [
    sections.profile,
    sections.admin,
    sections.hours,
    sections.menu,
    sections.whatsapp,
  ];
  const blockerCount = orderedSections.filter((section) => section.severity === "blocker").length;
  const warningCount = orderedSections.filter((section) => section.severity === "warning").length;
  const completedCount = orderedSections.filter((section) => section.status === "valid").length;

  return {
    ready: blockerCount === 0,
    summary: {
      blockerCount,
      warningCount,
      completedCount,
      totalCount: orderedSections.length,
      isFullyValid: blockerCount === 0,
    },
    checklist: {
      completedCount,
      totalCount: orderedSections.length,
      ready: blockerCount === 0,
      items: orderedSections.map((section) => ({
        key: section.key,
        label: section.label,
        done: section.status === "valid",
        detail: section.detail,
        status: section.status,
        severity: section.severity,
        issues: section.issues,
        resolution: CHECK_ACTIONS[section.key] || null,
      })),
    },
    sections,
  };
}

function getAllowedLifecycleTransition({
  currentState,
  nextState,
  validation,
}) {
  const current = String(currentState || "draft").trim().toLowerCase() || "draft";
  const next = String(nextState || "").trim().toLowerCase();
  const sections = validation && validation.sections ? validation.sections : {};

  const requiredSections = TRANSITION_RULES[current] && TRANSITION_RULES[current][next];
  if (!requiredSections) {
    return {
      allowed: false,
      code: "invalid_transition",
      message: `Cannot move restaurant lifecycle from ${current} to ${next}.`,
      blockers: [],
    };
  }

  const blockers = requiredSections
    .map((key) => sections[key])
    .filter((section) => section && section.status !== "valid")
    .map((section) => ({
      key: section.key,
      label: section.label,
      status: section.status,
      severity: section.severity,
      issues: section.issues,
      resolution: CHECK_ACTIONS[section.key] || null,
    }));

  if (blockers.length) {
    return {
      allowed: false,
      code: "lifecycle_requirements_not_met",
      message: `Restaurant is not ready to move to ${next}.`,
      blockers,
    };
  }

  return {
    allowed: true,
    code: "ok",
    message: "",
    blockers: [],
  };
}

function getLifecycleTransitionOptions({ currentState, validation }) {
  const current = String(currentState || "draft").trim().toLowerCase() || "draft";
  const currentIndex = LIFECYCLE_ORDER.indexOf(current);
  const statesToEvaluate =
    currentIndex >= 0 ? LIFECYCLE_ORDER.slice(currentIndex + 1) : LIFECYCLE_ORDER;

  return statesToEvaluate
    .filter((targetState) => targetState !== "activating")
    .map((targetState) => {
    const transition = getAllowedLifecycleTransition({
      currentState: current,
      nextState: targetState,
      validation,
    });

    return {
      targetState,
      allowed: transition.allowed,
      code: transition.code,
      message: transition.message,
      blockers: transition.blockers || [],
    };
    });
}

module.exports = {
  buildRestaurantActivationValidation,
  getAllowedLifecycleTransition,
  getLifecycleTransitionOptions,
};
