const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../email');

const router = express.Router();

const RESET_WINDOW_MS = 20 * 60 * 1000; // 20 minutes

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, facilityId: user.facility_id },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role,
    facilityId: user.facility_id,
    status: user.status,
    active: user.status === 'active', // kept for older frontend code that reads `active`
    createdBy: user.created_by || null,
    activationMethod: user.activation_method || null,
    enabledBy: user.enabled_by || null,
    enabledAt: user.enabled_at || null,
    setupCompletedAt: user.setup_completed_at || null,
  };
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// GET /api/auth/bootstrap-status — does any user exist yet?
router.get('/bootstrap-status', async (req, res) => {
  const { rows } = await pool.query('select count(*)::int as count from users');
  res.json({ needsBootstrap: rows[0].count === 0 });
});

// POST /api/auth/bootstrap — create the very first Super Admin. Only works once.
router.post('/bootstrap', async (req, res) => {
  const { name, username, email, password } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Name, username and password are required.' });
  }
  const { rows: existing } = await pool.query('select count(*)::int as count from users');
  if (existing[0].count > 0) {
    return res.status(409).json({ error: 'Setup already complete. Please sign in instead.' });
  }
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into users (name, username, email, password_hash, role, facility_id, status)
     values ($1, $2, $3, $4, 'superadmin', null, 'active') returning *`,
    [name, username, email || null, hash]
  );
  const user = rows[0];
  res.json({ token: signToken(user), user: publicUser(user) });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  const { rows } = await pool.query('select * from users where username = $1', [username]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Incorrect username or password.' });

  if (user.facility_id) {
    const { rows: facRows } = await pool.query('select active from facilities where id = $1', [user.facility_id]);
    if (facRows[0] && facRows[0].active === false) {
      return res.status(403).json({ error: 'Your facility has been disabled by the Super Admin. Contact them for assistance.' });
    }
  }

  // Super Admin activation bypass: the account is enabled but has no password yet.
  // The username alone is enough to route into first-time password setup — no email
  // link needed, matching the normal login page entry point the user is told to use.
  if (user.status === 'bypass_pending') {
    return res.json({ requiresSetup: true, setupToken: user.activation_token, name: user.name, username: user.username });
  }

  if (user.status === 'pending_activation') {
    return res.status(403).json({ error: 'This account is pending activation. Check your email for the activation link, or ask your administrator to resend it.' });
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended by an administrator.' });
  }
  if (user.status === 'inactive') {
    return res.status(403).json({ error: 'This account has been disabled by an administrator.' });
  }
  if (!user.password_hash) {
    return res.status(403).json({ error: 'This account has not completed activation yet.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });

  res.json({ token: signToken(user), user: publicUser(user) });
});

// GET /api/auth/me — restore session on page reload
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from users where id = $1', [req.user.id]);
  const user = rows[0];
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account no longer available.' });
  if (user.facility_id) {
    const { rows: facRows } = await pool.query('select active from facilities where id = $1', [user.facility_id]);
    if (facRows[0] && facRows[0].active === false) {
      return res.status(401).json({ error: 'Your facility has been disabled.' });
    }
  }
  res.json({ user: publicUser(user) });
});

// GET /api/auth/activation-info?token=... — used by the activation page to show the name/username
router.get('/activation-info', async (req, res) => {
  const { token } = req.query;
  const { rows } = await pool.query('select * from users where activation_token = $1', [token]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'This activation link is invalid.' });
  if (user.status !== 'pending_activation') {
    return res.status(400).json({ error: 'This account has already been activated.' });
  }
  if (new Date(user.activation_expires) < new Date()) {
    await pool.query(`update users set status = 'activation_expired' where id = $1`, [user.id]);
    return res.status(400).json({ error: 'This activation link has expired. Ask your administrator to resend it.' });
  }
  res.json({ name: user.name, username: user.username });
});

// POST /api/auth/activate — { token, password }
router.post('/activate', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Missing token or password.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { rows } = await pool.query('select * from users where activation_token = $1', [token]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'This activation link is invalid.' });
  if (!['pending_activation', 'bypass_pending'].includes(user.status)) {
    return res.status(400).json({ error: 'This account has already been activated.' });
  }
  // Bypass tokens have no expiry — they were issued by a Super Admin action, not a
  // time-boxed emailed link, so the account waits indefinitely for the user's first login.
  if (user.status === 'pending_activation' && new Date(user.activation_expires) < new Date()) {
    await pool.query(`update users set status = 'activation_expired' where id = $1`, [user.id]);
    return res.status(400).json({ error: 'This activation link has expired. Ask your administrator to resend it.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows: updated } = await pool.query(
    `update users set password_hash = $1, status = 'active', activation_token = null, activation_expires = null,
            setup_completed_at = now()
     where id = $2 returning *`,
    [hash, user.id]
  );
  const activeUser = updated[0];
  res.json({ token: signToken(activeUser), user: publicUser(activeUser) });
});

// POST /api/auth/forgot-password — { email }
// Always responds the same way whether or not the email exists, so we don't leak account info.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const { rows } = await pool.query(
    `select * from users where email = $1 and status = 'active'`,
    [email]
  );
  const user = rows[0];
  if (user) {
    const token = randomToken();
    const expires = new Date(Date.now() + RESET_WINDOW_MS);
    await pool.query('update users set reset_token = $1, reset_expires = $2 where id = $3', [token, expires, user.id]);
    await sendPasswordResetEmail({ to: user.email, name: user.name, token });
  }
  res.json({ message: 'If that email is associated with an account, a reset link has been sent.' });
});

// POST /api/auth/reset-password — { token, password }
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Missing token or password.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { rows } = await pool.query('select * from users where reset_token = $1', [token]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'This reset link is invalid.' });
  if (new Date(user.reset_expires) < new Date()) {
    return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'update users set password_hash = $1, reset_token = null, reset_expires = null where id = $2',
    [hash, user.id]
  );
  res.json({ message: 'Password updated. You can now sign in.' });
});

// POST /api/auth/change-password — logged-in self-service change
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  const { rows } = await pool.query('select * from users where id = $1', [req.user.id]);
  const user = rows[0];
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('update users set password_hash = $1 where id = $2', [hash, user.id]);
  res.json({ message: 'Password changed successfully.' });
});

module.exports = router;
