const nodemailer = require("nodemailer");
const {
  buildRestaurantActivationEmail,
} = require("../templates/restaurantActivationEmail");

function buildPortalContinueUrl(env = {}) {
  const baseUrl = String(
    (env && env.PORTAL_APP_URL) ||
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

function resolveSmtpConfig(env = {}) {
  const host = String((env && env.SMTP_HOST) || process.env.SMTP_HOST || "").trim();
  const port = Number((env && env.SMTP_PORT) || process.env.SMTP_PORT || 587);
  const user = String((env && env.SMTP_USER) || process.env.SMTP_USER || "").trim();
  const pass = String((env && env.SMTP_PASS) || process.env.SMTP_PASS || "").trim();
  const secure = String((env && env.SMTP_SECURE) || process.env.SMTP_SECURE || "")
    .trim()
    .toLowerCase();
  const fromEmail = String(
    (env && env.SMTP_FROM_EMAIL) ||
      process.env.SMTP_FROM_EMAIL ||
      "hello@servra.io"
  ).trim();
  const fromName = String(
    (env && env.SMTP_FROM_NAME) || process.env.SMTP_FROM_NAME || "Servra"
  ).trim();
  const replyTo = String(
    (env && env.SMTP_REPLY_TO) ||
      process.env.SMTP_REPLY_TO ||
      fromEmail
  ).trim();

  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    user,
    pass,
    secure: ["1", "true", "yes", "on"].includes(secure),
    fromEmail,
    fromName,
    replyTo,
    configured: Boolean(host && user && pass),
  };
}

function createEmailService({ admin, env = {}, transporter = null } = {}) {
  const smtpConfig = resolveSmtpConfig(env);
  let cachedTransporter = transporter;

  function getTransporter() {
    if (cachedTransporter) {
      return cachedTransporter;
    }

    if (!smtpConfig.configured) {
      const error = new Error(
        "Email delivery is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS."
      );
      error.statusCode = 500;
      throw error;
    }

    cachedTransporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      },
    });

    return cachedTransporter;
  }

  async function generatePasswordResetLink(email) {
    if (!admin || !admin.auth) {
      const error = new Error("Firebase Admin is required to generate activation links.");
      error.statusCode = 500;
      throw error;
    }

    const continueUrl = buildPortalContinueUrl(env);
    const actionCodeSettings = continueUrl ? { url: continueUrl, handleCodeInApp: false } : undefined;

    return admin.auth().generatePasswordResetLink(email, actionCodeSettings);
  }

  async function sendBrandedEmail({ to, subject, text, html }) {
    const mailOptions = {
      from: `"${smtpConfig.fromName}" <${smtpConfig.fromEmail}>`,
      to,
      replyTo: smtpConfig.replyTo,
      subject,
      text,
      html,
    };

    await getTransporter().sendMail(mailOptions);
  }

  async function sendRestaurantActivationEmail({
    email,
    displayName = "",
    restaurantName = "",
  } = {}) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      const error = new Error("Activation email address is required.");
      error.statusCode = 400;
      throw error;
    }

    const activationLink = await generatePasswordResetLink(normalizedEmail);
    const supportEmail = String(
      (env && env.SERVRA_BILLING_CONTACT_EMAIL) ||
        process.env.SERVRA_BILLING_CONTACT_EMAIL ||
        smtpConfig.fromEmail
    ).trim();

    const { subject, text, html } = buildRestaurantActivationEmail({
      displayName,
      restaurantName,
      activationLink,
      supportEmail,
    });

    await sendBrandedEmail({
      to: normalizedEmail,
      subject,
      text,
      html,
    });

    return {
      sent: true,
      to: normalizedEmail,
    };
  }

  async function sendWaitlistConfirmation(_email, _businessName) {
    return {
      sent: false,
      reason: "unsupported_without_smtp",
    };
  }

  return {
    sendRestaurantActivationEmail,
    sendWaitlistConfirmation,
    generatePasswordResetLink,
    buildPortalContinueUrl: () => buildPortalContinueUrl(env),
    resolveSmtpConfig: () => ({ ...smtpConfig, pass: undefined }),
  };
}

const defaultEmailService = createEmailService({
  admin: require("../../infra/firebase").admin,
  env: require("../../config/env").env,
});

module.exports = {
  createEmailService,
  sendRestaurantActivationEmail: defaultEmailService.sendRestaurantActivationEmail,
  sendWaitlistConfirmation: defaultEmailService.sendWaitlistConfirmation,
};
