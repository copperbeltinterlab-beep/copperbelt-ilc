const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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
    role: user.role,
    facilityId: user.facility_id,
    active: user.active,
  };
}

// GET /api/auth/bootstrap-status — does any user exist yet?
router.get('/bootstrap-status', async (req, res) => {
  const { rows } = await pool.query('select count(*)::int as count from users');
  res.json({ needsBootstrap: rows[0].count === 0 });
});

// POST /api/auth/bootstrap — create the very first Super Admin. Only works once.
router.post('/bootstrap', async (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Name, username and password are required.' });
  }
  const { rows: existing } = await pool.query('select count(*)::int as count from users');
  if (existing[0].count > 0) {
    return res.status(409).json({ error: 'Setup already complete. Please sign in instead.' });
  }
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into users (name, username, password_hash, role, facility_id, active)
     values ($1, $2, $3, 'superadmin', null, true) returning *`,
    [name, username, hash]
  );
  const user = rows[0];
  res.json({ token: signToken(user), user: publicUser(user) });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const { rows } = await pool.query('select * from users where username = $1', [username]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Incorrect username or password.' });
  if (!user.active) return res.status(403).json({ error: 'This account has been disabled by an admin.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });

  res.json({ token: signToken(user), user: publicUser(user) });
});

// GET /api/auth/me — restore session on page reload
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from users where id = $1', [req.user.id]);
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ error: 'Account no longer available.' });
  res.json({ user: publicUser(user) });
});

module.exports = router;
