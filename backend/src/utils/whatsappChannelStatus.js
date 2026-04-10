function normalizeSessionStatus(session) {
  const normalized = String(
    (session && (session.providerStatus || session.status || session.connection || "")) || ""
  )
    .trim()
    .toLowerCase();

  if (
    normalized.includes("connected") ||
    normalized.includes("ready") ||
    normalized.includes("authenticated")
  ) {
    return "connected";
  }

  if (normalized.includes("qr")) {
    return "qr_required";
  }

  if (
    normalized.includes("pending") ||
    normalized.includes("starting") ||
    normalized.includes("authenticating")
  ) {
    return "pending";
  }

  if (
    normalized.includes("disconnected") ||
    normalized.includes("error") ||
    normalized.includes("failed") ||
    normalized.includes("paused")
  ) {
    return "disconnected";
  }

  return normalized || "disconnected";
}

function normalizeProvisioningState(value, fallback = "unassigned") {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "unassigned",
    "reserved",
    "connecting",
    "verified",
    "active",
    "failed",
  ]);

  if (allowed.has(normalized)) {
    return normalized;
  }

  return fallback;
}

function getProvisioningMessage(provisioningState) {
  if (provisioningState === "reserved") {
    return "A WhatsApp line has been reserved for this restaurant, but connection has not started yet.";
  }
  if (provisioningState === "connecting") {
    return "WhatsApp provisioning is in progress for this restaurant.";
  }
  if (provisioningState === "verified") {
    return "WhatsApp identifiers are verified and ready for final activation.";
  }
  if (provisioningState === "active") {
    return "This restaurant has a live dedicated WhatsApp provisioning state.";
  }
  if (provisioningState === "failed") {
    return "WhatsApp provisioning failed and needs review before activation can continue.";
  }
  return "No WhatsApp line has been assigned to this restaurant yet.";
}

function getWhatsappProvisioningTransitions(provisioningState) {
  const current = normalizeProvisioningState(provisioningState);
  const rules = {
    unassigned: ["reserved"],
    reserved: ["connecting", "failed", "unassigned"],
    connecting: ["verified", "failed", "reserved"],
    verified: ["active", "failed", "connecting"],
    active: ["failed"],
    failed: ["reserved", "connecting", "unassigned"],
  };

  return (rules[current] || []).map((targetState) => ({
    targetState,
    label: targetState.replace(/_/g, " "),
  }));
}

function resolveWhatsappChannelStatus({ restaurant, restaurantId, session, env }) {
  const safeRestaurant = restaurant || {};
  const safeRestaurantId =
    String(restaurantId || safeRestaurant.id || safeRestaurant.restaurantId || "").trim();
  const whatsappConfig =
    safeRestaurant.whatsapp && typeof safeRestaurant.whatsapp === "object"
      ? safeRestaurant.whatsapp
      : {};

  const explicitPhoneNumber = String(
    whatsappConfig.phone || whatsappConfig.phoneNumber || ""
  ).trim();
  const explicitPhoneNumberId = String(whatsappConfig.phoneNumberId || "").trim();
  const explicitProvider = String(whatsappConfig.provider || "").trim().toLowerCase();
  const explicitlyConfigured = whatsappConfig.configured === true;
  const hasStoredSession = Boolean(session);
  const hasExplicitBinding =
    Boolean(explicitProvider) || Boolean(explicitPhoneNumber) || Boolean(explicitPhoneNumberId);
  const explicitProvisioningState = normalizeProvisioningState(
    whatsappConfig.provisioningState,
    hasStoredSession ? "active" : explicitlyConfigured || explicitProvider || explicitPhoneNumberId
      ? "reserved"
      : "unassigned"
  );

  const defaultMetaRestaurantId = String(
    (env && (env.META_WEBHOOK_DEFAULT_RESTAURANT_ID || env.BACKEND_DEFAULT_RESTAURANT_ID)) || ""
  ).trim();
  const defaultMetaConfigured = Boolean(
    env && env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID
  );
  const isDefaultMetaRestaurant =
    safeRestaurantId &&
    defaultMetaConfigured &&
    defaultMetaRestaurantId &&
    safeRestaurantId === defaultMetaRestaurantId;

  const isConfigured =
    hasStoredSession || explicitlyConfigured || hasExplicitBinding || isDefaultMetaRestaurant;

  if (!isConfigured) {
    return {
      restaurantId: safeRestaurantId,
      configured: false,
      bindingMode: "unconfigured",
      provider: "",
      status: "not_configured",
      phone: "",
      phoneNumberId: "",
      wabaId: "",
      runtimeOwner: "",
      routingMode: "unconfigured",
      routingHint: "Inbound traffic cannot resolve to this restaurant until a WhatsApp line is assigned.",
      qrAvailable: false,
      lastActive: null,
      provisioningState: "unassigned",
      activationReady: false,
      provisioningTransitions: getWhatsappProvisioningTransitions("unassigned"),
      setupMessage: "No WhatsApp line has been assigned to this restaurant yet.",
    };
  }

  if (hasStoredSession) {
    return {
      restaurantId: safeRestaurantId,
      configured: true,
      bindingMode: "session",
      provider: String(session.provider || explicitProvider || "whatsapp-web").trim(),
      status: normalizeSessionStatus(session),
      phone: String(session.phoneNumber || session.phone || session.msisdn || explicitPhoneNumber).trim(),
      phoneNumberId: String(session.phoneNumberId || explicitPhoneNumberId).trim(),
      wabaId: String(session.wabaId || whatsappConfig.wabaId || "").trim(),
      runtimeOwner: String(session.runtimeOwner || "").trim(),
      routingMode: "direct_session_binding",
      routingHint: "Inbound traffic resolves directly to this restaurant from its active session binding.",
      qrAvailable: Boolean(session.qrAvailable),
      lastActive: session.updatedAt || session.lastSeenAt || session.createdAt || null,
      provisioningState: "active",
      activationReady: true,
      provisioningTransitions: [],
      setupMessage: "",
    };
  }

  if (isDefaultMetaRestaurant) {
    return {
      restaurantId: safeRestaurantId,
      configured: true,
      bindingMode: "global_meta_default",
      provider: "meta-whatsapp-cloud-api",
      status: "connected",
      phone: explicitPhoneNumber,
      phoneNumberId: explicitPhoneNumberId || String(env.META_PHONE_NUMBER_ID || "").trim(),
      wabaId: String(whatsappConfig.wabaId || env.META_WABA_ID || "").trim(),
      runtimeOwner: "meta-whatsapp-cloud-api",
      routingMode: "default_restaurant_fallback",
      routingHint:
        "Inbound Meta traffic falls back to this restaurant when no dedicated tenant-specific line match is found.",
      qrAvailable: false,
      lastActive: null,
      provisioningState: "active",
      activationReady: true,
      provisioningTransitions: [],
      setupMessage:
        "This restaurant is currently using the default shared Meta test line configured on the backend.",
    };
  }

  return {
    restaurantId: safeRestaurantId,
    configured: true,
    bindingMode: "configured_pending_session",
    provider: explicitProvider || "meta-whatsapp-cloud-api",
    status: "pending",
    phone: explicitPhoneNumber,
    phoneNumberId: explicitPhoneNumberId,
    wabaId: String(whatsappConfig.wabaId || "").trim(),
    runtimeOwner: "",
    routingMode: "dedicated_config_binding",
    routingHint:
      "Inbound Meta traffic can resolve to this restaurant from its saved dedicated WhatsApp identifiers.",
    qrAvailable: false,
    lastActive: null,
    provisioningState: explicitProvisioningState,
    activationReady: explicitProvisioningState === "verified" || explicitProvisioningState === "active",
    provisioningTransitions: getWhatsappProvisioningTransitions(explicitProvisioningState),
    setupMessage:
      String(whatsappConfig.notes || "").trim() ||
      getProvisioningMessage(explicitProvisioningState),
  };
}

module.exports = {
  normalizeSessionStatus,
  normalizeProvisioningState,
  getWhatsappProvisioningTransitions,
  resolveWhatsappChannelStatus,
};
