const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESEND_FROM_EMAIL || 'Copperbelt ILC <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'http://localhost:5500';

async function sendMail({ to, subject, html }) {
  if (!resend) {
    console.warn('RESEND_API_KEY not set — skipping email send. Would have sent:', { to, subject });
    return;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (e) {
    console.error('Failed to send email via Resend:', e.message);
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

module.exports = {
  sendActivationEmail,
  sendPasswordResetEmail,
  sendFeedbackReleasedEmail,
  sendFollowUpQueryEmail,
};
