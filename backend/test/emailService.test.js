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

test("sendRestaurantActivationEmail generates link and sends branded mail", async () => {
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
  assert.equal(result.to, "owner@example.com");
  assert.equal(generatedLinks.length, 1);
  assert.equal(generatedLinks[0].email, "owner@example.com");
  assert.equal(generatedLinks[0].settings.url, "https://portal.servra.io/reset-password");
  assert.equal(capturedMail.from, '"Servra" <hello@servra.io>');
  assert.equal(capturedMail.to, "owner@example.com");
  assert.equal(capturedMail.replyTo, "hello@servra.io");
  assert.match(capturedMail.subject, /Welcome to Servra/);
  assert.match(capturedMail.html, /Tasty Bites/);
});

test("sendRestaurantActivationEmail fails clearly when SMTP is not configured", async () => {
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
