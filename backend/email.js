const nodemailer = require('nodemailer');

const SMTP_CONFIGURED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = SMTP_CONFIGURED
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      // Port 465 is implicit TLS; anything else (587, 25) starts plaintext and upgrades via
      // STARTTLS. SMTP_SECURE lets you override this if a provider doesn't follow that norm.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

const FROM = process.env.SMTP_FROM_EMAIL || 'Copperbelt ILC <no-reply@example.com>';
const APP_URL = process.env.APP_URL || 'http://localhost:5500';

async function sendMail({ to, subject, html }) {
  if (!transporter) {
    console.warn('SMTP_HOST/SMTP_USER/SMTP_PASS not set — skipping email send. Would have sent:', { to, subject });
    return;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
  } catch (e) {
    console.error('Failed to send email via SMTP:', e.message);
  }
}

function brandHeader() {
  return `
    <div style="font-family: Arial, sans-serif; text-align:center; padding-bottom:16px; border-bottom:2px solid #0d3b30; margin-bottom:20px;">
      <div style="font-size:12px; letter-spacing:1px; color:#555;">MINISTRY OF HEALTH, ZAMBIA</div>
      <div style="font-size:16px; font-weight:bold; color:#0d3b30;">Copperbelt Interlaboratory Comparison Programme</div>
    </div>`;
}

async function sendActivationEmail({ to, name, token }) {
  const link = `${APP_URL}/?activate=${token}`;
  await sendMail({
    to,
    subject: 'Activate your Copperbelt ILC account',
    html: `${brandHeader()}
      <p>Hello ${name},</p>
      <p>An administrator has created an account for you on the Copperbelt Interlaboratory Comparison Programme system.</p>
      <p><a href="${link}" style="background:#0d3b30;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px;">Activate Account</a></p>
      <p>This link expires in 20 minutes. If it expires, ask your administrator to resend the activation email.</p>
      <p style="font-size:12px;color:#888;">If the button doesn't work, copy this link into your browser: ${link}</p>`,
  });
}

async function sendPasswordResetEmail({ to, name, token }) {
  const link = `${APP_URL}/?reset=${token}`;
  await sendMail({
    to,
    subject: 'Reset your Copperbelt ILC password',
    html: `${brandHeader()}
      <p>Hello ${name},</p>
      <p>We received a request to reset your password. If you didn't request this, you can ignore this email.</p>
      <p><a href="${link}" style="background:#0d3b30;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px;">Reset Password</a></p>
      <p>This link expires in 20 minutes.</p>
      <p style="font-size:12px;color:#888;">If the button doesn't work, copy this link into your browser: ${link}</p>`,
  });
}

async function sendFeedbackReleasedEmail({ to, name, roundLabel }) {
  await sendMail({
    to,
    subject: 'Performance feedback released — Copperbelt ILC',
    html: `${brandHeader()}
      <p>Hello ${name},</p>
      <p>Feedback for <strong>${roundLabel}</strong> has been released. Please log in to the Copperbelt ILC system to view your Performance Report.</p>
      <p><a href="${APP_URL}" style="background:#0d3b30;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px;">View Feedback</a></p>`,
  });
}

async function sendFollowUpQueryEmail({ to, personnelName, facilityName, messageBody, context }) {
  await sendMail({
    to,
    subject: `Follow-up query from ${facilityName}${context ? ' — ' + context : ''}`,
    html: `${brandHeader()}
      <p><strong>From:</strong> ${personnelName} (${facilityName})</p>
      ${context ? `<p><strong>Regarding:</strong> ${context}</p>` : ''}
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap; border-left:3px solid #ddd; padding-left:12px;">${messageBody}</p>`,
  });
}

async function sendDeletionRequestEmail({ to, requesterName, facilityName, roundLabel, reason }) {
  await sendMail({
    to,
    subject: `Round deletion requested — ${roundLabel}`,
    html: `${brandHeader()}
      <p><strong>${requesterName}</strong> (${facilityName}) has requested deletion of <strong>${roundLabel}</strong>.</p>
      ${reason ? `<p><strong>Reason given:</strong></p><p style="white-space:pre-wrap; border-left:3px solid #ddd; padding-left:12px;">${reason}</p>` : ''}
      <p>Only a Super Admin can delete a round. Log in to review and act on this request.</p>
      <p><a href="${APP_URL}" style="background:#0d3b30;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px;">Review in Copperbelt ILC</a></p>`,
  });
}

module.exports = {
  sendActivationEmail,
  sendPasswordResetEmail,
  sendFeedbackReleasedEmail,
  sendFollowUpQueryEmail,
  sendDeletionRequestEmail,
};
