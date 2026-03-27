const { authError } = require("./authErrors");
const { ROLES, isValidRole, resolvePermissionsForUser } = require("./permissions");

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

function createAuthService({ admin, userRepo, logger }) {
  async function verifySessionByIdToken(idToken) {
    if (typeof idToken !== "string" || !idToken.trim()) {
      throw authError(401, "missing_token", "Missing Bearer token");
    }

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

    const profile = await userRepo.getUserByUid(uid);
    if (!profile) {
      throw authError(404, "user_profile_missing", "User profile not found");
    }

    if (profile.isActive !== true) {
      throw authError(403, "user_inactive", "User account is inactive");
    }

    const role = String(profile.role || "").trim();
    if (!isValidRole(role)) {
      throw authError(403, "invalid_user_role", "User profile has an invalid role");
    }

    const normalizedRestaurantId = normalizeRestaurantId(role, profile.restaurantId);
    const permissions = resolvePermissionsForUser({
      role,
      permissions: profile.permissions,
    });

    return {
      uid,
      email: String(profile.email || decodedToken.email || ""),
      displayName: String(
        profile.displayName || decodedToken.name || decodedToken.email || ""
      ),
      role,
      restaurantId: normalizedRestaurantId,
      permissions,
      isActive: true,
      createdAt: profile.createdAt || null,
      updatedAt: profile.updatedAt || null,
    };
  }

  return {
    verifySessionByIdToken,
  };
}

module.exports = {
  createAuthService,
};
