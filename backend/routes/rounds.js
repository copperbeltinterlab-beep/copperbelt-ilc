const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isEligibleParticipant } = require('../participation');

const router = express.Router();

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
    instructionsFileName: r.instructions_file_name || null,
    participationMode: r.participation_mode || 'all',
    participantFacilityIds: r.participant_facility_ids || null,
    roundPackageId: r.round_package_id || null,
  };
}

// GET /api/rounds — flat, per-sample view. Still used internally by sample-level screens
// (result entry, feedback grading, printed reports). Round CREATION now happens exclusively
// through POST /api/round-packages, which creates a package and its samples together — see
// routes/roundPackages.js. Facility Users only see rounds their facility is eligible for.
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from rounds order by deadline');
  let visible = rows;
  if (req.user.role === 'user') {
    visible = rows.filter(r => isEligibleParticipant(r, req.user.facilityId));
  }
  res.json(visible.map(camel));
});

// GET /api/rounds/:roundId/instructions-file — download the attached instructions file.
// New (post-packaging) rounds don't carry their own file — it lives on the parent package —
// so this falls back to the package's file when the round itself has none.
router.get('/:roundId/instructions-file', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from rounds where id = $1', [req.params.roundId]);
  const round = rows[0];
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (round.instructions_file_data) {
    const buffer = Buffer.from(round.instructions_file_data, 'base64');
    res.setHeader('Content-Type', round.instructions_file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${round.instructions_file_name || 'instructions'}"`);
    return res.send(buffer);
  }
  if (round.round_package_id) {
    const { rows: pkgRows } = await pool.query('select * from round_packages where id = $1', [round.round_package_id]);
    const pkg = pkgRows[0];
    if (pkg && pkg.instructions_file_data) {
      const buffer = Buffer.from(pkg.instructions_file_data, 'base64');
      res.setHeader('Content-Type', pkg.instructions_file_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${pkg.instructions_file_name || 'instructions'}"`);
      return res.send(buffer);
    }
  }
  res.status(404).json({ error: 'No file attached to this round.' });
});

module.exports = router;
