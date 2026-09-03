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

// POST /api/rounds — Facility Admin creates a single-sample round provided by THEIR facility.
// Kept for backward compatibility; new UI uses POST /api/rounds/batch for multi-sample creation.
router.post('/', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const { testId, sampleId, deadline, instructions } = req.body;
  if (!testId || !sampleId || !deadline) {
    return res.status(400).json({ error: 'Test, sample ID and deadline are required.' });
  }
  const { rows } = await pool.query(
    `insert into rounds (test_id, sample_id, providing_facility_id, deadline, instructions)
     values ($1, $2, $3, $4, $5) returning *`,
    [testId, sampleId, req.user.facilityId, deadline, instructions || null]
  );
  res.json(camel(rows[0]));
});

// POST /api/rounds/batch — Facility Admin creates several samples for the same test in one go
// (e.g. Sample A, Sample B, Sample C), sharing the same deadline and instructions.
router.post('/batch', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const { testId, sampleIds, deadline, instructions } = req.body;
  if (!testId || !deadline) {
    return res.status(400).json({ error: 'Test and deadline are required.' });
  }
  if (!Array.isArray(sampleIds) || sampleIds.length < 2 || sampleIds.length > 5) {
    return res.status(400).json({ error: 'Provide between 2 and 5 sample names.' });
  }
  if (sampleIds.some(s => !s || !String(s).trim())) {
    return res.status(400).json({ error: 'Every sample must have a name.' });
  }
  const batchId = `${testId}-${Date.now()}`;
  const created = [];
  for (const sampleId of sampleIds) {
    const { rows } = await pool.query(
      `insert into rounds (test_id, sample_id, providing_facility_id, deadline, instructions, batch_id)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [testId, String(sampleId).trim(), req.user.facilityId, deadline, instructions || null, batchId]
    );
    created.push(camel(rows[0]));
  }
  res.json(created);
});

// GET /api/facilities/public is handled in facilities.js — nothing needed here.

function toDateOnly(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function camel(r) {
  return {
    id: r.id,
    testId: r.test_id,
    sampleId: r.sample_id,
    providingFacilityId: r.providing_facility_id,
    deadline: toDateOnly(r.deadline),
    deadlineHistory: r.deadline_history || [],
    instructions: r.instructions || '',
    batchId: r.batch_id || null,
  };
}

module.exports = router;
