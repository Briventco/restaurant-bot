const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRestaurantActivationEmail } = require("../src/domain/templates/restaurantActivationEmail");
const { createEmailService } = require("../src/domain/services/emailService");

test("buildRestaurantActivationEmail renders branded subject and body", () => {
  const email = buildRestaurantActivationEmail({
    displayName: "Jane Doe",
    restaurantName: "Tasty Bites",
    activationLink: "https://portal.servra.io/reset?code=abc123",
    supportEmail: "hello@servra.io",
  });

  assert.equal(email.subject, "Welcome to Servra — set up Tasty Bites");
  assert.match(email.text, /Hi Jane Doe,/);
  assert.match(email.text, /Tasty Bites/);
  assert.match(email.text, /https:\/\/portal\.servra\.io\/reset\?code=abc123/);
  assert.match(email.html, /Set your password/);
  assert.match(email.html, /Tasty Bites/);
  assert.match(email.html, /hello@servra\.io/);
});

test("sendRestaurantActivationEmail sends via SMTP transporter", async () => {
  const generatedLinks = [];
  let capturedMail = null;

  const emailService = createEmailService({
    admin: {
      auth: () => ({
        generatePasswordResetLink: async (email, settings) => {
          generatedLinks.push({ email, settings });
          return "https://auth.example.com/reset?oobCode=test123";
        },
      }),
    },
    env: {
      PORTAL_APP_URL: "https://portal.servra.io",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 587,
      SMTP_USER: "hello@servra.io",
      SMTP_PASS: "secret",
      SMTP_FROM_EMAIL: "hello@servra.io",
      SMTP_FROM_NAME: "Servra",
      SMTP_REPLY_TO: "hello@servra.io",
    },
    transporter: {
      sendMail: async (payload) => {
        capturedMail = payload;
      },
    },
  });

  const result = await emailService.sendRestaurantActivationEmail({
    email: "owner@example.com",
    displayName: "Jane Doe",
    restaurantName: "Tasty Bites",
  });

  assert.equal(result.sent, true);
  assert.equal(result.transport, "smtp");
  assert.equal(generatedLinks[0].settings.url, "https://portal.servra.io/reset-password");
  assert.equal(capturedMail.from, '"Servra" <hello@servra.io>');
  assert.match(capturedMail.subject, /Welcome to Servra/);
});

test("sendRestaurantActivationEmail sends via Resend when API key is set", async () => {
  const originalFetch = global.fetch;
  let capturedRequest = null;

  global.fetch = async (url, options) => {
    capturedRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ id: "email_123" }),
    };
  };

  try {
    const emailService = createEmailService({
      admin: {
        auth: () => ({
          generatePasswordResetLink: async () => "https://auth.example.com/reset?oobCode=test123",
        }),
      },
      env: {
        RESEND_API_KEY: "re_test_key",
        SMTP_FROM_EMAIL: "hello@servra.io",
        SMTP_FROM_NAME: "Servra",
        SMTP_REPLY_TO: "hello@servra.io",
      },
    });

    const result = await emailService.sendRestaurantActivationEmail({
      email: "owner@example.com",
      restaurantName: "Tasty Bites",
    });

    assert.equal(result.transport, "resend");
    assert.equal(capturedRequest.url, "https://api.resend.com/emails");
    assert.equal(capturedRequest.body.from, "Servra <hello@servra.io>");
    assert.deepEqual(capturedRequest.body.to, ["owner@example.com"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendRestaurantActivationEmail fails clearly when email transport is not configured", async () => {
  const emailService = createEmailService({
    admin: {
      auth: () => ({
        generatePasswordResetLink: async () => "https://auth.example.com/reset?oobCode=test123",
      }),
    },
    env: {
      PORTAL_APP_URL: "https://portal.servra.io",
    },
  });

  await assert.rejects(
    () =>
      emailService.sendRestaurantActivationEmail({
        email: "owner@example.com",
      }),
    /Email delivery is not configured/
  );
});
