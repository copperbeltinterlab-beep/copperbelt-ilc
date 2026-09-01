const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendActivationEmail } = require('../email');

const router = express.Router();

const ACTIVATION_WINDOW_MS = 20 * 60 * 1000; // 20 minutes

function publicUser(u) {
  return {
    id: u.id, name: u.name, username: u.username, email: u.email,
    role: u.role, facilityId: u.facility_id, status: u.status,
    active: u.status === 'active',
  };
}
function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// GET /api/users
// Super Admin: everyone. Facility Admin: only their own facility's users.
router.get('/', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  let rows;
  if (req.user.role === 'superadmin') {
    ({ rows } = await pool.query('select * from users order by name'));
  } else {
    ({ rows } = await pool.query(
      'select * from users where facility_id = $1 order by name',
      [req.user.facilityId]
    ));
  }
  res.json(rows.map(publicUser));
});

// POST /api/users
// Super Admin: can create any role, at any facility.
// Facility Admin: can only create role 'user', tied to their own facility.
// Creates the account as 'pending_activation' and emails an activation link —
// the admin never sets or knows the user's password.
router.post('/', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  let { name, username, email, role, facilityId } = req.body;
  if (!name || !username || !email) {
    return res.status(400).json({ error: 'Name, username and email are required.' });
  }

  if (req.user.role === 'facilityadmin') {
    role = 'user';
    facilityId = req.user.facilityId;
  } else {
    if (!['superadmin', 'facilityadmin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (role !== 'superadmin' && !facilityId) {
      return res.status(400).json({ error: 'A facility is required for this role.' });
    }
  }

  const { rows: dupe } = await pool.query(
    'select id from users where username = $1 or email = $2', [username, email]
  );
  if (dupe.length) return res.status(409).json({ error: 'That username or email is already in use.' });

  const token = randomToken();
  const expires = new Date(Date.now() + ACTIVATION_WINDOW_MS);
  const { rows } = await pool.query(
    `insert into users (name, username, email, password_hash, role, facility_id, status, activation_token, activation_expires)
     values ($1, $2, $3, null, $4, $5, 'pending_activation', $6, $7) returning *`,
    [name, username, email, role, facilityId || null, token, expires]
  );
  const user = rows[0];
  await sendActivationEmail({ to: email, name, token });
  res.json(publicUser(user));
});

// POST /api/users/:id/resend-activation
router.post('/:id/resend-activation', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (req.user.role === 'facilityadmin' && target.facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'You can only manage users at your own facility.' });
  }
  if (!['pending_activation', 'activation_expired'].includes(target.status)) {
    return res.status(400).json({ error: 'This account is not awaiting activation.' });
  }
  if (!target.email) return res.status(400).json({ error: 'This user has no email on file.' });

  const token = randomToken();
  const expires = new Date(Date.now() + ACTIVATION_WINDOW_MS);
  await pool.query(
    `update users set activation_token = $1, activation_expires = $2, status = 'pending_activation' where id = $3`,
    [token, expires, target.id]
  );
  await sendActivationEmail({ to: target.email, name: target.name, token });
  res.json({ message: 'Activation email resent.' });
});

// PATCH /api/users/:id/active — enable/disable an account (active <-> inactive)
router.patch('/:id/active', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  const { active } = req.body;
  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (req.user.role === 'facilityadmin' && target.facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'You can only manage users at your own facility.' });
  }

  const newStatus = active ? 'active' : 'inactive';
  const { rows } = await pool.query(
    'update users set status = $1 where id = $2 returning *',
    [newStatus, req.params.id]
  );
  res.json(publicUser(rows[0]));
});

// PATCH /api/users/:id/suspend — suspend or unsuspend (distinct from disable, per spec #3)
router.patch('/:id/suspend', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  const { suspended } = req.body;
  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (req.user.role === 'facilityadmin' && target.facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'You can only manage users at your own facility.' });
  }
  const newStatus = suspended ? 'suspended' : 'active';
  const { rows } = await pool.query('update users set status = $1 where id = $2 returning *', [newStatus, req.params.id]);
  res.json(publicUser(rows[0]));
});

// PATCH /api/users/:id/role — upgrade/downgrade a user's role (and facility, if relevant)
// Super Admin only.
router.patch('/:id/role', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { role, facilityId } = req.body;
  if (!['superadmin', 'facilityadmin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  if (role !== 'superadmin' && !facilityId) {
    return res.status(400).json({ error: 'A facility is required for this role.' });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(403).json({ error: 'You cannot change your own role.' });
  }

  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'User not found.' });

  const { rows } = await pool.query(
    'update users set role = $1, facility_id = $2 where id = $3 returning *',
    [role, role === 'superadmin' ? null : facilityId, req.params.id]
  );
  res.json(publicUser(rows[0]));
});

// DELETE /api/users/:id
// Kept for cases with no historical data attached. Per spec #3, prefer deactivation
// where deletion could affect historical records — the frontend should offer
// "Disable" as the primary action and reserve Delete for accounts with no submission history.
router.delete('/:id', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(403).json({ error: 'You cannot delete your own account.' });
  }

  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (req.user.role === 'facilityadmin') {
    if (target.facility_id !== req.user.facilityId || target.role !== 'user') {
      return res.status(403).json({ error: 'You can only delete facility user accounts at your own facility.' });
    }
  }

  await pool.query('delete from users where id = $1', [req.params.id]);
  res.json({ deleted: true });
});

module.exports = router;
