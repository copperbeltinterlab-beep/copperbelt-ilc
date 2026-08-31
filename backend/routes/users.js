const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function publicUser(u) {
  return { id: u.id, name: u.name, username: u.username, role: u.role, facilityId: u.facility_id, active: u.active };
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
router.post('/', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  let { name, username, password, role, facilityId } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Name, username and password are required.' });
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

  const { rows: dupe } = await pool.query('select id from users where username = $1', [username]);
  if (dupe.length) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into users (name, username, password_hash, role, facility_id, active)
     values ($1, $2, $3, $4, $5, true) returning *`,
    [name, username, hash, role, facilityId || null]
  );
  res.json(publicUser(rows[0]));
});

// PATCH /api/users/:id/active — enable/disable an account
router.patch('/:id/active', requireAuth, requireRole('superadmin', 'facilityadmin'), async (req, res) => {
  const { active } = req.body;
  const { rows: existingRows } = await pool.query('select * from users where id = $1', [req.params.id]);
  const target = existingRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (req.user.role === 'facilityadmin' && target.facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'You can only manage users at your own facility.' });
  }

  const { rows } = await pool.query(
    'update users set active = $1 where id = $2 returning *',
    [!!active, req.params.id]
  );
  res.json(publicUser(rows[0]));
});

module.exports = router;
