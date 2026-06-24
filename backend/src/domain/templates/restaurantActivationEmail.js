function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildRestaurantActivationEmail({
  displayName = "",
  restaurantName = "",
  activationLink = "",
  supportEmail = "hello@servra.io",
}) {
  const safeName = escapeHtml(displayName || "there");
  const safeRestaurant = escapeHtml(restaurantName || "your restaurant");
  const safeLink = escapeHtml(activationLink);
  const safeSupport = escapeHtml(supportEmail);

  const subject = restaurantName
    ? `Welcome to Servra — set up ${restaurantName}`
    : "Welcome to Servra — set up your restaurant portal";

  const text = [
    `Hi ${displayName || "there"},`,
    "",
    `Your restaurant portal for ${restaurantName || "your restaurant"} is ready on Servra.`,
    "",
    "Click the link below to choose your password and sign in:",
    activationLink,
    "",
    "This link expires in 24 hours. If you did not expect this email, you can safely ignore it.",
    "",
    `Need help? Reply to this email or contact us at ${supportEmail}.`,
    "",
    "— The Servra Team",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:#1a1a2e;padding:28px 32px;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Servra</p>
              <p style="margin:6px 0 0;font-size:13px;color:#a0aec0;">Restaurant ordering, simplified</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">Hi ${safeName},</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4a5568;">
                Your restaurant portal for <strong>${safeRestaurant}</strong> is ready.
                Click the button below to choose your password and sign in to your dashboard.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0;">
                <tr>
                  <td style="border-radius:8px;background:#2563eb;">
                    <a href="${safeLink}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                      Set your password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#718096;">
                This link expires in 24 hours. If the button does not work, copy and paste this URL into your browser:
              </p>
              <p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;color:#2563eb;">
                <a href="${safeLink}" style="color:#2563eb;">${safeLink}</a>
              </p>
              <p style="margin:0;font-size:13px;line-height:1.5;color:#a0aec0;">
                Did not expect this email? You can safely ignore it.<br>
                Need help? Contact us at <a href="mailto:${safeSupport}" style="color:#2563eb;">${safeSupport}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background:#f7fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#a0aec0;text-align:center;">
                &copy; Servra &middot; <a href="https://servra.io" style="color:#718096;text-decoration:none;">servra.io</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

module.exports = {
  buildRestaurantActivationEmail,
};
