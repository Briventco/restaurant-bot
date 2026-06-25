const nodemailer = require("nodemailer");
const logger = require("../../infra/logger");
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

function resolveEmailConfig(env = {}) {
  const resendApiKey = String(
    (env && env.RESEND_API_KEY) || process.env.RESEND_API_KEY || ""
  ).trim();
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

  let transport = "none";
  if (resendApiKey) {
    transport = "resend";
  } else if (host && user && pass) {
    transport = "smtp";
  }

  return {
    transport,
    resendApiKey,
    host,
    port: Number.isFinite(port) ? port : 587,
    user,
    pass,
    secure: ["1", "true", "yes", "on"].includes(secure),
    fromEmail,
    fromName,
    replyTo,
    configured: transport !== "none",
  };
}

function createEmailService({ admin, env = {}, transporter = null } = {}) {
  const emailConfig = resolveEmailConfig(env);
  let cachedTransporter = transporter;

  function getSmtpTransporter() {
    if (cachedTransporter) {
      return cachedTransporter;
    }

    if (emailConfig.transport !== "smtp") {
      const error = new Error(
        "SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS, or use RESEND_API_KEY."
      );
      error.statusCode = 500;
      throw error;
    }

    cachedTransporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      requireTLS: !emailConfig.secure && emailConfig.port === 587,
      auth: {
        user: emailConfig.user,
        pass: emailConfig.pass,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });

    return cachedTransporter;
  }

  async function sendViaResend({ to, subject, text, html }) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${emailConfig.resendApiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "servra-backend/1.0",
      },
      body: JSON.stringify({
        from: `${emailConfig.fromName} <${emailConfig.fromEmail}>`,
        to: [to],
        subject,
        html,
        text,
        reply_to: emailConfig.replyTo,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        String(payload?.message || payload?.error || "Resend rejected the email.")
      );
      error.statusCode = response.status || 502;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async function sendViaSmtp({ to, subject, text, html }) {
    const mailOptions = {
      from: `"${emailConfig.fromName}" <${emailConfig.fromEmail}>`,
      to,
      replyTo: emailConfig.replyTo,
      subject,
      text,
      html,
    };

    await getSmtpTransporter().sendMail(mailOptions);
  }

  async function generatePasswordResetLink(email) {
    if (!admin || !admin.auth) {
      const error = new Error("Firebase Admin is required to generate activation links.");
      error.statusCode = 500;
      throw error;
    }

    const continueUrl = buildPortalContinueUrl(env);
    const actionCodeSettings = continueUrl
      ? { url: continueUrl, handleCodeInApp: false }
      : undefined;

    return admin.auth().generatePasswordResetLink(email, actionCodeSettings);
  }

  async function sendBrandedEmail({ to, subject, text, html, context = {} }) {
    const logContext = {
      to,
      subject,
      transport: emailConfig.transport,
      ...context,
    };

    logger.info("Sending restaurant activation email", logContext);

    try {
      if (emailConfig.transport === "resend") {
        await sendViaResend({ to, subject, text, html });
      } else if (emailConfig.transport === "smtp") {
        await sendViaSmtp({ to, subject, text, html });
      } else {
        const error = new Error(
          "Email delivery is not configured. Set RESEND_API_KEY (recommended on Render) or SMTP_HOST/SMTP_USER/SMTP_PASS."
        );
        error.statusCode = 500;
        throw error;
      }

      logger.info("Restaurant activation email sent", logContext);
    } catch (error) {
      logger.error("Restaurant activation email failed", {
        ...logContext,
        message: error.message,
        code: error.code || "",
      });
      throw error;
    }
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
        emailConfig.fromEmail
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
      context: {
        restaurantName,
        displayName,
      },
    });

    return {
      sent: true,
      to: normalizedEmail,
      transport: emailConfig.transport,
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
    resolveEmailConfig: () => ({
      transport: emailConfig.transport,
      fromEmail: emailConfig.fromEmail,
      fromName: emailConfig.fromName,
      replyTo: emailConfig.replyTo,
      host: emailConfig.host,
      port: emailConfig.port,
      configured: emailConfig.configured,
    }),
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
