const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function camel(f) {
  return { id: f.id, name: f.name, town: f.town, facilityType: f.facility_type };
}

// GET /api/facilities — anyone signed in can see the list (needed for names/dropdowns)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from facilities order by name');
  res.json(rows.map(camel));
});

// POST /api/facilities — Super Admin only
router.post('/', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { name, town, facilityType } = req.body;
  if (!name) return res.status(400).json({ error: 'Facility name is required.' });
  if (facilityType && !['government', 'private'].includes(facilityType)) {
    return res.status(400).json({ error: 'Facility type must be government or private.' });
  }
  const { rows } = await pool.query(
    'insert into facilities (name, town, facility_type) values ($1, $2, $3) returning *',
    [name, town || null, facilityType || 'government']
  );
  res.json(camel(rows[0]));
});

module.exports = router;
