const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/rounds — everyone signed in can see all rounds (users need to see active rounds
// across the province; admins need to see what their facility provides)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from rounds order by deadline');
  res.json(rows.map(camel));
});

// POST /api/rounds — Facility Admin creates a round provided by THEIR facility.
router.post('/', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const { testId, sampleId, deadline } = req.body;
  if (!testId || !sampleId || !deadline) {
    return res.status(400).json({ error: 'Test, sample ID and deadline are required.' });
  }
  const { rows } = await pool.query(
    `insert into rounds (test_id, sample_id, providing_facility_id, deadline)
     values ($1, $2, $3, $4) returning *`,
    [testId, sampleId, req.user.facilityId, deadline]
  );
  res.json(camel(rows[0]));
});

function camel(r) {
  return {
    id: r.id,
    testId: r.test_id,
    sampleId: r.sample_id,
    providingFacilityId: r.providing_facility_id,
    deadline: r.deadline,
  };
}

module.exports = router;
