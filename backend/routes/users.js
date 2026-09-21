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
    createdBy: u.created_by || null,
    activationMethod: u.activation_method || null,
    enabledBy: u.enabled_by || null,
    enabledAt: u.enabled_at || null,
    setupCompletedAt: u.setup_completed_at || null,
  };
}
function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}
const MAX_FACILITY_ADMINS = 2;
async function facilityAdminCount(facilityId, excludeUserId) {
  const { rows } = await pool.query(
    `select count(*)::int as count from users
     where facility_id = $1 and role = 'facilityadmin' and id != coalesce($2, -1)`,
    [facilityId, excludeUserId || null]
  );
  return rows[0].count;
}

// GET /api/users
// Super Admin: everyone. Facility Admin: only their own facility's users.
router.get('/', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  // Super Admins are not affiliated with any facility (programme-level accounts).
  await pool.query(`update users set facility_id = null where role = 'superadmin' and facility_id is not null`);
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
// Creates the account as 'pending_activation' (or 'bypass_pending') with no username
// or password — the account owner chooses both during activation (email link or
// first-time login with their email). Admins never set or know credentials.
router.post('/', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  let { name, email, role, facilityId, activationMethod } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  if (req.user.role === 'facilityadmin') {
    role = 'user';
    facilityId = req.user.facilityId;
  } else {
    if (!['superadmin', 'facilityadmin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (role === 'superadmin') {
      facilityId = null;
    } else if (!facilityId) {
      return res.status(400).json({ error: 'A facility is required for this role.' });
    }
    if (role === 'facilityadmin') {
      const count = await facilityAdminCount(facilityId);
      if (count >= MAX_FACILITY_ADMINS) {
        return res.status(409).json({ error: `This facility already has ${MAX_FACILITY_ADMINS} Facility Admins — the maximum allowed.` });
      }
    }
  }

  // The bypass is a Super Admin-only administrative exception. A Facility Admin's request
  // body is never trusted for this — it's silently forced to the normal email flow.
  const useBypass = req.user.role === 'superadmin' && activationMethod === 'bypass';

  const trimmedEmail = String(email).trim();
  email = trimmedEmail;

  const { rows: emailDupes } = await pool.query(
    `select id, email from users where lower(email) = lower($1)`,
    [trimmedEmail]
  );
  if (emailDupes.length) {
    return res.status(409).json({ error: `Email "${emailDupes[0].email}" is already registered to another account.` });
  }

  const token = randomToken();
  const expires = new Date(Date.now() + ACTIVATION_WINDOW_MS);
  const status = useBypass ? 'bypass_pending' : 'pending_activation';

  // Username is left null until the account owner picks one at activation.
  const { rows } = await pool.query(
    `insert into users
       (name, username, email, password_hash, role, facility_id, status, activation_token, activation_expires,
        created_by, activation_method, enabled_by, enabled_at)
     values ($1, null, $2, null, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
    [name, email, role, facilityId || null, status, token, useBypass ? null : expires,
     req.user.id, useBypass ? 'bypass' : 'email',
     useBypass ? req.user.id : null, useBypass ? new Date() : null]
  );
  const user = rows[0];
  if (useBypass) {
    res.json(publicUser(user));
  } else {
    await sendActivationEmail({ to: email, name, token });
    res.json(publicUser(user));
  }
});

// POST /api/users/:id/enable-bypass — Super Admin only. For a user still pending the normal
// email-activation flow (typically created by a Facility Admin), this switches them to the
// bypass path: no email is sent, and the user instead completes first-time username +
// password setup the next time they enter their email on the normal login page.
router.post('/:id/enable-bypass', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!['pending_activation', 'activation_expired'].includes(target.status)) {
    return res.status(400).json({ error: 'This account is not awaiting activation.' });
  }

  const token = randomToken();
  const { rows } = await pool.query(
    `update users set status = 'bypass_pending', activation_token = $1, activation_expires = null,
            activation_method = 'bypass', enabled_by = $2, enabled_at = now()
     where id = $3 returning *`,
    [token, req.user.id, target.id]
  );
  res.json(publicUser(rows[0]));
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
  if (active && target.status === 'bypass_pending') {
    return res.status(400).json({ error: 'This account is already enabled and awaiting the user\'s first-time password setup.' });
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
router.patch('/:id/role', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  let { role, facilityId } = req.body;
  if (Number(req.params.id) === req.user.id) {
    return res.status(403).json({ error: 'You cannot change your own role.' });
  }

  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (req.user.role === 'facilityadmin') {
    // A Facility Admin may only reassign between Facility User and Facility Admin, only for
    // someone already at their own facility, and can never grant Super Admin or move anyone
    // to a different facility — that stays a Super Admin-only power.
    if (target.facility_id !== req.user.facilityId) {
      return res.status(403).json({ error: 'You can only manage users at your own facility.' });
    }
    if (!['user', 'facilityadmin'].includes(role)) {
      return res.status(403).json({ error: 'Facility Admins can only assign the Facility User or Facility Admin role.' });
    }
    facilityId = req.user.facilityId;
  } else {
    if (!['superadmin', 'facilityadmin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (role !== 'superadmin' && !facilityId) {
      return res.status(400).json({ error: 'A facility is required for this role.' });
    }
  }

  if (role === 'facilityadmin') {
    const count = await facilityAdminCount(facilityId, Number(req.params.id));
    if (count >= MAX_FACILITY_ADMINS) {
      return res.status(409).json({ error: `This facility already has ${MAX_FACILITY_ADMINS} Facility Admins — the maximum allowed.` });
    }
  }

  const { rows } = await pool.query(
    'update users set role = $1, facility_id = $2 where id = $3 returning *',
    [role, role === 'superadmin' ? null : facilityId, req.params.id]
  );
  res.json(publicUser(rows[0]));
});

// PATCH /api/users/:id/details — edit a user's name/email (and username only if already set
// by the account owner). Super Admin can edit anyone; Facility Admin only users at their
// own facility. Username remains optional for accounts still awaiting activation.
router.patch('/:id/details', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  let { name, username, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (req.user.role === 'facilityadmin' && target.facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'You can only manage users at your own facility.' });
  }

  const trimmedEmail = String(email).trim();
  // Only update username if the admin supplies one and the account already has (or is being given) one.
  // Prefer leaving username null until the owner chooses it at activation.
  const hasUsernameInput = username != null && String(username).trim() !== '';
  const trimmedUsername = hasUsernameInput ? String(username).trim() : (target.username || null);

  if (trimmedUsername) {
    const { rows: userDupes } = await pool.query(
      `select id, username, email from users
        where (lower(username) = lower($1) or lower(email) = lower($2)) and id != $3`,
      [trimmedUsername, trimmedEmail, req.params.id]
    );
    if (userDupes.length) {
      const byUser = userDupes.find(u => u.username && u.username.toLowerCase() === trimmedUsername.toLowerCase());
      if (byUser) {
        return res.status(409).json({ error: `Username "${byUser.username}" is already taken. Choose a different username.` });
      }
      const byEmail = userDupes.find(u => (u.email || '').toLowerCase() === trimmedEmail.toLowerCase());
      if (byEmail) {
        return res.status(409).json({ error: `Email "${byEmail.email}" is already registered to another account.` });
      }
      return res.status(409).json({ error: 'That username or email is already in use.' });
    }
  } else {
    const { rows: emailDupes } = await pool.query(
      `select id, email from users where lower(email) = lower($1) and id != $2`,
      [trimmedEmail, req.params.id]
    );
    if (emailDupes.length) {
      return res.status(409).json({ error: `Email "${emailDupes[0].email}" is already registered to another account.` });
    }
  }

  const { rows } = await pool.query(
    'update users set name = $1, username = $2, email = $3 where id = $4 returning *',
    [name, trimmedUsername, trimmedEmail, req.params.id]
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

  try {
    // Clear soft references that may lack ON DELETE SET NULL in older DBs
    await pool.query('update submissions set tested_by_user_id = null where tested_by_user_id = $1', [req.params.id]);
    await pool.query('update submissions set verified_by_user_id = null where verified_by_user_id = $1', [req.params.id]);
    await pool.query('delete from users where id = $1', [req.params.id]);
  } catch (e) {
    if (e && e.code === '23503') {
      return res.status(409).json({
        error: 'This user is still linked to historical records. Prefer Disable instead of Delete.',
      });
    }
    console.error('User delete failed:', e.message);
    return res.status(500).json({ error: 'Could not delete user. Try again, or disable the account instead.' });
  }
  res.json({ deleted: true });
});

// GET /api/users/facility-admin-counts — Super Admin only. Map of facilityId -> current
// Facility Admin count, used by the "Add User" form to grey out the option at the cap.
router.get('/facility-admin-counts', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { rows } = await pool.query(
    `select facility_id, count(*)::int as count from users where role = 'facilityadmin' group by facility_id`
  );
  const map = {};
  rows.forEach(r => { map[r.facility_id] = r.count; });
  res.json(map);
});


// POST /api/users/:id/admin-set-password — Super Admin only, special circumstances.
// Sets a new password the user can use immediately (communicate offline; not emailed).
router.post('/:id/admin-set-password', requireAuth, requireRole('superadmin'), async (req, res) => {
  const password = (req.body.password || '').trim();
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (Number(target.id) === Number(req.user.id)) {
    return res.status(400).json({ error: 'Use Change password for your own account.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `update users set
       password_hash = $1,
       status = 'active',
       reset_token = null,
       reset_expires = null,
       activation_token = null,
       activation_expires = null
     where id = $2 returning *`,
    [hash, target.id]
  );
  res.json({
    message: `Password updated for ${rows[0].name} (${rows[0].username}). Share the new password securely offline.`,
    user: publicUser(rows[0]),
  });
});

module.exports = router;
