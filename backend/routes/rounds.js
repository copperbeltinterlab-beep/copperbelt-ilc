const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap

function toDateOnly(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

const { isEligibleParticipant } = require('../participation');

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
  };
}




// GET /api/rounds — everyone signed in can see all rounds, except Facility Users only
// see rounds their facility is eligible to participate in (Select All / Select Individual).
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from rounds order by deadline');
  let visible = rows;
  if (req.user.role === 'user') {
    visible = rows.filter(r => isEligibleParticipant(r, req.user.facilityId));
  }
  res.json(visible.map(camel));
});

// GET /api/rounds/:roundId/instructions-file — download the attached instructions file
router.get('/:roundId/instructions-file', requireAuth, async (req, res) => {
  const { rows } = await pool.query('select * from rounds where id = $1', [req.params.roundId]);
  const round = rows[0];
  if (!round || !round.instructions_file_data) return res.status(404).json({ error: 'No file attached to this round.' });
  const buffer = Buffer.from(round.instructions_file_data, 'base64');
  res.setHeader('Content-Type', round.instructions_file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${round.instructions_file_name || 'instructions'}"`);
  res.send(buffer);
});

// POST /api/rounds/batch — Facility Admin creates several samples for the same test in one go,
// sharing the same deadline, mandatory instructions, and an optional instructions file.
// multipart/form-data: testId, deadline, instructions, sampleIds (JSON string array), instructionsFile (optional)
router.post('/batch', requireAuth, requireRole('facilityadmin'), upload.single('instructionsFile'), async (req, res) => {
  const { testId, deadline, instructions, participationMode } = req.body;
  let sampleIds;
  try {
    sampleIds = JSON.parse(req.body.sampleIds);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid sample list.' });
  }
  if (!testId || !deadline) {
    return res.status(400).json({ error: 'Test and deadline are required.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'An instructions file attachment is required.' });
  }
  if (!Array.isArray(sampleIds) || sampleIds.length < 2 || sampleIds.length > 5) {
    return res.status(400).json({ error: 'Provide between 2 and 5 sample names.' });
  }
  if (sampleIds.some(s => !s || !String(s).trim())) {
    return res.status(400).json({ error: 'Every sample must have a name.' });
  }

  const mode = participationMode === 'selected' ? 'selected' : 'all';
  let participantFacilityIds = null;
  if (mode === 'selected') {
    try {
      participantFacilityIds = JSON.parse(req.body.participantFacilityIds || '[]').map(Number);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid participating facilities list.' });
    }
    if (!Array.isArray(participantFacilityIds) || participantFacilityIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one participating facility, or choose "All facilities".' });
    }
  }

  const fileName = req.file.originalname;
  const fileType = req.file.mimetype;
  const fileData = req.file.buffer.toString('base64');

  const batchId = `${testId}-${Date.now()}`;
  const created = [];
  for (const sampleId of sampleIds) {
    const { rows } = await pool.query(
      `insert into rounds
         (test_id, sample_id, providing_facility_id, deadline, instructions, batch_id,
          instructions_file_name, instructions_file_type, instructions_file_data,
          participation_mode, participant_facility_ids)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [testId, String(sampleId).trim(), req.user.facilityId, deadline, (instructions || '').trim(), batchId,
       fileName, fileType, fileData,
       mode, participantFacilityIds ? JSON.stringify(participantFacilityIds) : null]
    );
    created.push(camel(rows[0]));
  }
  res.json(created);
});

module.exports = router;
