const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function camel(f) {
  return { id: f.id, name: f.name, town: f.town, facilityType: f.facility_type, active: f.active };
}

// GET /api/facilities/public — no auth required. Powers the public landing page's
// "Participating Laboratories" list. Only name/town/type — nothing sensitive.
router.get('/public', async (req, res) => {
  const { rows } = await pool.query(
    'select name, town, facility_type from facilities where active = true order by name'
  );
  res.json(rows.map(f => ({ name: f.name, town: f.town, facilityType: f.facility_type })));
});

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

// PATCH /api/facilities/:id — modify name/town/type. Super Admin only.
router.patch('/:id', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { name, town, facilityType } = req.body;
  const { rows: existingRows } = await pool.query('select * from facilities where id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Facility not found.' });
  if (facilityType && !['government', 'private'].includes(facilityType)) {
    return res.status(400).json({ error: 'Facility type must be government or private.' });
  }
  const { rows } = await pool.query(
    `update facilities set name = $1, town = $2, facility_type = $3 where id = $4 returning *`,
    [name || existing.name, town !== undefined ? town : existing.town,
     facilityType || existing.facility_type, req.params.id]
  );
  res.json(camel(rows[0]));
});

// PATCH /api/facilities/:id/active — disable/enable a facility. Super Admin only.
// Disabling blocks sign-in for that facility's users/admins (checked at login).
router.patch('/:id/active', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { active } = req.body;
  const { rows } = await pool.query(
    'update facilities set active = $1 where id = $2 returning *',
    [!!active, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Facility not found.' });
  res.json(camel(rows[0]));
});

// DELETE /api/facilities/:id — Super Admin only. Blocked if the facility still has
// users or rounds attached, to avoid orphaning accounts or silently cascading away
// historical PT data. Disable first (above), reassign/remove dependents, then delete.
router.delete('/:id', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { rows: userRows } = await pool.query('select count(*)::int as count from users where facility_id = $1', [req.params.id]);
  if (userRows[0].count > 0) {
    return res.status(409).json({ error: `This facility still has ${userRows[0].count} user account(s). Remove or reassign them first.` });
  }
  const { rows: roundRows } = await pool.query('select count(*)::int as count from rounds where providing_facility_id = $1', [req.params.id]);
  if (roundRows[0].count > 0) {
    return res.status(409).json({ error: `This facility still provides ${roundRows[0].count} round(s) of PT data. It cannot be deleted while that history exists.` });
  }
  const { rows } = await pool.query('delete from facilities where id = $1 returning id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Facility not found.' });
  res.json({ deleted: true });
});

module.exports = router;
