const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/facilities — anyone signed in can see the list (needed for names/dropdowns)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from facilities order by name');
  res.json(rows);
});

// POST /api/facilities — Super Admin only
router.post('/', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { name, town } = req.body;
  if (!name) return res.status(400).json({ error: 'Facility name is required.' });
  const { rows } = await pool.query(
    'insert into facilities (name, town) values ($1, $2) returning *',
    [name, town || null]
  );
  res.json(rows[0]);
});

module.exports = router;
