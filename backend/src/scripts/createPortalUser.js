require("dotenv").config();

const { admin } = require("../infra/firebase");
const userRepo = require("../repositories/userRepo");
const { ROLES, getDefaultPermissionsForRole } = require("../auth/permissions");

function printUsageAndExit() {
  console.error(
    "Usage: node src/scripts/createPortalUser.js <email> <password> <role> [restaurantId] [displayName]"
  );
  console.error(
    "Example: node src/scripts/createPortalUser.js owner@demo.com admin123 restaurant_admin lead_mall \"Lead Mall Admin\""
  );
  process.exit(1);
}

async function main() {
  const [, , emailArg, passwordArg, roleArg, restaurantIdArg, displayNameArg] = process.argv;

  const email = String(emailArg || "").trim().toLowerCase();
  const password = String(passwordArg || "").trim();
  const role = String(roleArg || "").trim();
  const restaurantId = String(restaurantIdArg || "").trim();
  const displayName = String(displayNameArg || "").trim();

  if (!email || !password || !role) {
    printUsageAndExit();
  }

  if (!Object.values(ROLES).includes(role)) {
    throw new Error(`Invalid role "${role}". Expected one of: ${Object.values(ROLES).join(", ")}`);
  }

  if (role !== ROLES.SUPER_ADMIN && !restaurantId) {
    throw new Error("restaurantId is required for restaurant_admin and restaurant_staff");
  }

  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(authUser.uid, {
      password,
      displayName: displayName || authUser.displayName || email,
      disabled: false,
    });
  } catch (error) {
    if (error && error.code === "auth/user-not-found") {
      authUser = await admin.auth().createUser({
        email,
        password,
        displayName: displayName || email,
        disabled: false,
      });
    } else {
      throw error;
    }
  }

  const profile = await userRepo.upsertUser(authUser.uid, {
    email,
    displayName: displayName || authUser.displayName || email,
    role,
    restaurantId: role === ROLES.SUPER_ADMIN ? null : restaurantId,
    permissions: getDefaultPermissionsForRole(role),
    isActive: true,
  });

  console.info(
    JSON.stringify(
      {
        success: true,
        uid: authUser.uid,
        email,
        role,
        restaurantId: profile.restaurantId || null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
