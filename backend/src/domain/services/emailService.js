function getFirebaseWebApiKey() {
  return String(
    process.env.FIREBASE_WEB_API_KEY ||
      process.env.FIREBASE_API_KEY ||
      process.env.VITE_FIREBASE_API_KEY ||
      ""
  ).trim();
}

function buildPortalContinueUrl() {
  const baseUrl = String(
    process.env.PORTAL_APP_URL ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      process.env.VITE_APP_URL ||
      ""
  )
    .trim()
    .replace(/\/$/, "");

  if (!baseUrl) {
    return "";
  }

  try {
    return new URL("/reset-password", baseUrl).toString();
  } catch (_error) {
    return "";
  }
}

async function sendFirebasePasswordResetEmail(email) {
  const apiKey = getFirebaseWebApiKey();
  if (!apiKey) {
    const error = new Error("Missing Firebase web API key for email delivery.");
    error.statusCode = 500;
    throw error;
  }

  const continueUrl = buildPortalContinueUrl();
  const body = {
    requestType: "PASSWORD_RESET",
    email,
  };

  if (continueUrl) {
    body.continueUrl = continueUrl;
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(
      String(payload?.error?.message || "Unable to send activation email.")
        .trim()
    );
    error.code = payload?.error?.message || "";
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function sendRestaurantActivationEmail(email) {
  await sendFirebasePasswordResetEmail(email);
  return {
    sent: true,
  };
}

async function sendWaitlistConfirmation(_email, _businessName) {
  return {
    sent: false,
    reason: "unsupported_without_smtp",
  };
}

module.exports = {
  sendRestaurantActivationEmail,
  sendWaitlistConfirmation,
};
