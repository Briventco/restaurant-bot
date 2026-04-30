const { authError } = require("./authErrors");
const { ROLES, isValidRole, resolvePermissionsForUser } = require("./permissions");
const crypto = require("crypto");

function summarizeToken(idToken) {
  const normalized = String(idToken || "").trim();
  if (!normalized) {
    return {
      present: false,
      length: 0,
      preview: "",
    };
  }

  return {
    present: true,
    length: normalized.length,
    preview: normalized.slice(0, 12),
  };
}

function normalizeRestaurantId(role, restaurantId) {
  if (role === ROLES.SUPER_ADMIN) {
    return null;
  }

  if (typeof restaurantId !== "string" || !restaurantId.trim()) {
    throw authError(
      403,
      "invalid_user_profile",
      "Restaurant user profile is missing restaurantId"
    );
  }

  return restaurantId.trim();
}

function mapTokenError(error) {
  if (!error || typeof error !== "object") {
    return authError(401, "token_invalid", "Invalid authentication token");
  }

  const tokenErrorCodes = new Set([
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/argument-error",
    "auth/invalid-id-token",
  ]);

  if (tokenErrorCodes.has(error.code)) {
    return authError(401, "token_invalid", "Invalid or expired authentication token");
  }

  return authError(401, "token_invalid", "Failed to verify authentication token");
}

const { normalizeOnboardingState } = require("../domain/services/restaurantOnboardingService");

function createAuthService({ admin, userRepo, restaurantRepo, logger }) {
  const tokenCache = new Map();
  const inFlightVerification = new Map();
  const tokenCacheTtlMs = 60 * 1000;

  function hashToken(idToken) {
    return crypto
      .createHash("sha256")
      .update(String(idToken || ""), "utf8")
      .digest("hex");
  }

  function cloneAuthUser(user) {
    return {
      ...user,
      permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
      onboarding: user.onboarding && typeof user.onboarding === "object" ? { ...user.onboarding } : user.onboarding,
    };
  }

  async function verifyAndBuildUser(idToken) {
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken.trim());
    } catch (error) {
      logger.warn("Firebase token verification failed", {
        code: error.code || "",
        message: error.message || "",
      });
      throw mapTokenError(error);
    }

    const uid = String(decodedToken.uid || "");
    if (!uid) {
      throw authError(401, "token_invalid", "Token does not include a uid");
    }

    logger.debug("Firebase token verified", {
      uid,
      email: String(decodedToken.email || ""),
    });

    const profile = await userRepo.getUserByUid(uid);
    if (!profile) {
      logger.warn("User profile lookup failed", {
        uid,
      });
      throw authError(404, "user_profile_missing", "User profile not found");
    }

    if (profile.isActive !== true) {
      logger.warn("User profile inactive", {
        uid,
        role: String(profile.role || ""),
        restaurantId: String(profile.restaurantId || ""),
      });
      throw authError(403, "user_inactive", "User account is inactive");
    }

    const role = String(profile.role || "").trim();
    if (!isValidRole(role)) {
      logger.warn("User profile has invalid role", {
        uid,
        role,
      });
      throw authError(403, "invalid_user_role", "User profile has an invalid role");
    }

    const normalizedRestaurantId = normalizeRestaurantId(role, profile.restaurantId);
    const permissions = resolvePermissionsForUser({
      role,
      permissions: profile.permissions,
    });
    const restaurant =
      normalizedRestaurantId && restaurantRepo
        ? await restaurantRepo.getRestaurantById(normalizedRestaurantId)
        : null;
    const onboarding = normalizeOnboardingState(
      restaurant && restaurant.onboarding ? restaurant.onboarding : null
    );

    logger.debug("Auth session verification succeeded", {
      uid,
      role,
      restaurantId: normalizedRestaurantId,
      permissionsCount: permissions.length,
    });

    return {
      uid,
      email: String(profile.email || decodedToken.email || ""),
      displayName: String(
        profile.displayName || decodedToken.name || decodedToken.email || ""
      ),
      role,
      restaurantId: normalizedRestaurantId,
      restaurantName: restaurant && restaurant.name ? String(restaurant.name) : "",
      permissions,
      onboarding,
      isActive: true,
      createdAt: profile.createdAt || null,
      updatedAt: profile.updatedAt || null,
    };
  }

  async function verifySessionByIdToken(idToken) {
    if (typeof idToken !== "string" || !idToken.trim()) {
      throw authError(401, "missing_token", "Missing Bearer token");
    }

    logger.debug("Auth session verification started", {
      token: summarizeToken(idToken),
    });
    const tokenHash = hashToken(idToken.trim());
    const now = Date.now();
    const cached = tokenCache.get(tokenHash);
    if (cached && cached.expiresAt > now) {
      logger.debug("Auth session verification cache hit", {
        tokenHashPrefix: tokenHash.slice(0, 12),
      });
      return cloneAuthUser(cached.user);
    }

    if (inFlightVerification.has(tokenHash)) {
      logger.debug("Auth session verification coalesced", {
        tokenHashPrefix: tokenHash.slice(0, 12),
      });
      return cloneAuthUser(await inFlightVerification.get(tokenHash));
    }

    const verificationPromise = verifyAndBuildUser(idToken).finally(() => {
      inFlightVerification.delete(tokenHash);
    });
    inFlightVerification.set(tokenHash, verificationPromise);

    const user = await verificationPromise;
    tokenCache.set(tokenHash, {
      user: cloneAuthUser(user),
      expiresAt: now + tokenCacheTtlMs,
    });
    return cloneAuthUser(user);
  }

  return {
    verifySessionByIdToken,
  };
}

module.exports = {
  createAuthService,
};
