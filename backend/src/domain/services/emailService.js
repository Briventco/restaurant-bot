const nodemailer = require("nodemailer");

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

function buildWaitlistHtml(businessName) {
  const safe = String(businessName || "there").trim();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're on the Servra waitlist</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
          style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#25d366;padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:28px;letter-spacing:-0.5px;">Servra</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">
                AI-powered WhatsApp ordering for restaurants
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 12px;color:#1a1a1a;font-size:22px;">
                You're on the list, ${safe}! 🎉
              </h2>
              <p style="margin:0 0 24px;color:#555555;font-size:15px;line-height:1.6;">
                Thanks for signing up. We've added <strong>${safe}</strong> to the Servra waitlist
                and we'll be in touch as soon as we're ready to bring you onboard.
              </p>

              <p style="margin:0 0 12px;color:#1a1a1a;font-size:15px;font-weight:bold;">
                Here's what Servra does for your business:
              </p>
              <ul style="margin:0 0 28px;padding-left:20px;color:#555555;font-size:15px;line-height:1.9;">
                <li>Takes and manages customer orders directly on WhatsApp — no app needed</li>
                <li>Uses AI to understand orders in plain language, including pidgin and typos</li>
                <li>Notifies you instantly and lets you confirm or reject orders by reply</li>
                <li>Tracks payment status, delivery, and full order history in one dashboard</li>
              </ul>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
                <tr>
                  <td style="background:#25d366;border-radius:6px;">
                    <a href="https://servra.io"
                      style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;
                             font-weight:bold;text-decoration:none;letter-spacing:0.2px;">
                      Learn more at servra.io →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#555555;font-size:15px;line-height:1.6;">
                We'll reach out soon. In the meantime, feel free to reply to this email
                if you have any questions.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9f9f9;padding:24px 40px;border-top:1px solid #eeeeee;">
              <p style="margin:0;color:#888888;font-size:13px;line-height:1.6;">
                — Caleb<br />
                <strong>Founder, Servra</strong><br />
                <a href="mailto:hello@servra.io"
                  style="color:#25d366;text-decoration:none;">hello@servra.io</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

async function sendWaitlistConfirmation(email, businessName) {
  const transporter = createTransporter();
  const html = buildWaitlistHtml(businessName);

  await transporter.sendMail({
    from: `"Servra" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "You're on the Servra waitlist 🎉",
    html,
  });
}

module.exports = {
  sendWaitlistConfirmation,
};
