const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isEligibleParticipant } = require('../participation');
const { computeStatus, toDateOnly } = require('../roundPackageStatus');
const { buildConsensusReport } = require('../consensus');
const { sendDeletionRequestEmail } = require('../email');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap

const MIN_YEAR = 2026;
const MAX_YEAR = 2035; // generous forward window; extend later if ever needed

// "Round 1 of 2027" — falls back gracefully for legacy backfilled packages that have no
// known year/round number rather than fabricating one.
function packageLabel(p) {
  if (p.year && p.round_number) return `Round ${p.round_number} of ${p.year}`;
  if (p.year) return `Round — of ${p.year}`;
  return 'Round — (pre-existing)';
}

function camel(p, samples) {
  return {
    id: p.id,
    testId: p.test_id,
    year: p.year,
    roundNumber: p.round_number,
    label: packageLabel(p),
    providingFacilityId: p.providing_facility_id,
    deadline: toDateOnly(p.deadline),
    instructionsFileName: p.instructions_file_name || null,
    participationMode: p.participation_mode || 'all',
    participantFacilityIds: p.participant_facility_ids || null,
    status: computeStatus(p),
    closedAt: p.closed_at || null,
    closedBy: p.closed_by || null,
    deletionRequestedBy: p.deletion_requested_by || null,
    deletionRequestedAt: p.deletion_requested_at || null,
    deletionRequestReason: p.deletion_request_reason || null,
    createdAt: p.created_at,
    createdBy: p.created_by || null,
    samples: (samples || []).map(s => ({
      id: s.id,
      sampleId: s.sample_id,
      deadline: toDateOnly(s.deadline),
      deadlineHistory: s.deadline_history || [],
    })),
  };
}

async function getPackage(id) {
  const { rows } = await pool.query('select * from round_packages where id = $1', [id]);
  return rows[0];
}
async function getSamples(packageId) {
  const { rows } = await pool.query('select * from rounds where round_package_id = $1 order by id', [packageId]);
  return rows;
}

// GET /api/round-packages — everyone signed in sees every package EXCEPT Facility Users,
// who only see packages that are (a) still active and (b) open to their facility (Select
// All / Select Individual participation). This is enforced here, not just hidden in the UI —
// a non-participant or a closed round is never even present in the response for role 'user'.
router.get('/', requireAuth, async (req, res) => {
  const { rows: packages } = await pool.query('select * from round_packages order by created_at desc');
  const { rows: allSamples } = await pool.query('select * from rounds where round_package_id is not null order by id');
  const byPackage = {};
  allSamples.forEach(s => { (byPackage[s.round_package_id] = byPackage[s.round_package_id] || []).push(s); });

  let visible = packages;
  if (req.user.role === 'user') {
    visible = packages.filter(p => computeStatus(p) === 'active' && isEligibleParticipant(p, req.user.facilityId));
  }
  res.json(visible.map(p => camel(p, byPackage[p.id])));
});

// GET /api/round-packages/:id/instructions-file
router.get('/:id/instructions-file', requireAuth, async (req, res) => {
  const pkg = await getPackage(req.params.id);
  if (!pkg || !pkg.instructions_file_data) return res.status(404).json({ error: 'No file attached to this round.' });
  const buffer = Buffer.from(pkg.instructions_file_data, 'base64');
  res.setHeader('Content-Type', pkg.instructions_file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${pkg.instructions_file_name || 'instructions'}"`);
  res.send(buffer);
});

// POST /api/round-packages — Facility Admin creates a round package: one test, an ILC
// Year + Round Number, 2-5 samples, mandatory instructions file, and participation settings.
// multipart/form-data: testId, year, roundNumber, deadline, sampleIds (JSON array),
// participationMode, participantFacilityIds (JSON array, if selected), instructionsFile.
router.post('/', requireAuth, requireRole('facilityadmin'), upload.single('instructionsFile'), async (req, res) => {
  const { testId, deadline, participationMode } = req.body;
  const year = Number(req.body.year);
  const roundNumber = Number(req.body.roundNumber);
  let sampleIds;
  try {
    sampleIds = JSON.parse(req.body.sampleIds);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid sample list.' });
  }

  if (!testId || !deadline) return res.status(400).json({ error: 'Test and deadline are required.' });
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    return res.status(400).json({ error: 'Select a valid ILC year.' });
  }
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 10) {
    return res.status(400).json({ error: 'Select a round number (1-10).' });
  }
  if (!req.file) return res.status(400).json({ error: 'An instructions file attachment is required.' });
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

  const { rows: dupe } = await pool.query(
    'select id from round_packages where year = $1 and round_number = $2 and test_id = $3',
    [year, roundNumber, testId]
  );
  if (dupe.length) {
    return res.status(409).json({ error: `Round ${roundNumber} of ${year} already exists for this test.` });
  }

  const fileName = req.file.originalname;
  const fileType = req.file.mimetype;
  const fileData = req.file.buffer.toString('base64');
  const participantJson = participantFacilityIds ? JSON.stringify(participantFacilityIds) : null;

  const { rows: pkgRows } = await pool.query(
    `insert into round_packages
       (test_id, year, round_number, providing_facility_id, deadline,
        instructions_file_name, instructions_file_type, instructions_file_data,
        participation_mode, participant_facility_ids, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11) returning *`,
    [testId, year, roundNumber, req.user.facilityId, deadline, fileName, fileType, fileData,
     mode, participantJson, req.user.id]
  );
  const pkg = pkgRows[0];

  const createdSamples = [];
  for (const sampleId of sampleIds) {
    const { rows } = await pool.query(
      `insert into rounds
         (test_id, sample_id, providing_facility_id, deadline, round_package_id,
          participation_mode, participant_facility_ids)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [testId, String(sampleId).trim(), req.user.facilityId, deadline, pkg.id, mode, participantJson]
    );
    createdSamples.push(rows[0]);
  }
  res.json(camel(pkg, createdSamples));
});

// PATCH /api/round-packages/:id — correct mistakes / add omitted samples on an existing
// package without creating a new one. Blocked once the round is closed. Facility Admin may
// only modify their own facility's rounds; Super Admin may modify any (oversight parity with
// the existing deadline-change endpoint).
router.patch('/:id', requireAuth, requireRole('facilityadmin', 'superadmin'), upload.single('instructionsFile'), async (req, res) => {
  const pkg = await getPackage(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Round not found.' });
  if (req.user.role === 'facilityadmin' && pkg.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  if (computeStatus(pkg) === 'closed') {
    return res.status(403).json({ error: 'This round is closed and can no longer be modified. Reopen it first if this was unintentional.' });
  }

  const updates = {};
  const { deadline, deadlineReason, participationMode } = req.body;

  if (deadline && deadline !== toDateOnly(pkg.deadline)) {
    if (!(deadlineReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when changing the deadline.' });
    }
    updates.deadline = deadline;
    const historyEntry = {
      previousDeadline: toDateOnly(pkg.deadline),
      newDeadline: deadline,
      reason: deadlineReason.trim(),
      changedBy: req.user.name,
      changedAt: new Date().toISOString(),
    };
    const children = await getSamples(pkg.id);
    for (const child of children) {
      const hist = Array.isArray(child.deadline_history) ? child.deadline_history : [];
      hist.push(historyEntry);
      await pool.query('update rounds set deadline = $1, deadline_history = $2 where id = $3',
        [deadline, JSON.stringify(hist), child.id]);
    }
  }

  let mode = pkg.participation_mode;
  let participantFacilityIds = pkg.participant_facility_ids;
  if (participationMode) {
    mode = participationMode === 'selected' ? 'selected' : 'all';
    if (mode === 'selected') {
      try {
        participantFacilityIds = JSON.parse(req.body.participantFacilityIds || '[]').map(Number);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid participating facilities list.' });
      }
      if (!Array.isArray(participantFacilityIds) || participantFacilityIds.length === 0) {
        return res.status(400).json({ error: 'Select at least one participating facility, or choose "All facilities".' });
      }
    } else {
      participantFacilityIds = null;
    }
    updates.participation_mode = mode;
    updates.participant_facility_ids = participantFacilityIds ? JSON.stringify(participantFacilityIds) : null;
    await pool.query(
      'update rounds set participation_mode = $1, participant_facility_ids = $2 where round_package_id = $3',
      [mode, participantFacilityIds ? JSON.stringify(participantFacilityIds) : null, pkg.id]
    );
  }

  if (req.file) {
    updates.instructions_file_name = req.file.originalname;
    updates.instructions_file_type = req.file.mimetype;
    updates.instructions_file_data = req.file.buffer.toString('base64');
  }

  if (Object.keys(updates).length) {
    const cols = Object.keys(updates);
    const setClause = cols.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await pool.query(`update round_packages set ${setClause} where id = $${cols.length + 1}`,
      [...cols.map(k => updates[k]), pkg.id]);
  }

  if (req.body.addSamples) {
    let names;
    try {
      names = JSON.parse(req.body.addSamples);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid sample list.' });
    }
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'Provide at least one sample name to add.' });
    }
    if (names.some(n => !n || !String(n).trim())) {
      return res.status(400).json({ error: 'Every added sample must have a name.' });
    }
    const existingCount = (await getSamples(pkg.id)).length;
    if (existingCount + names.length > 5) {
      return res.status(400).json({ error: `This would bring the round to ${existingCount + names.length} samples — the maximum is 5.` });
    }
    const effectiveDeadline = updates.deadline || toDateOnly(pkg.deadline);
    for (const name of names) {
      await pool.query(
        `insert into rounds
           (test_id, sample_id, providing_facility_id, deadline, round_package_id,
            participation_mode, participant_facility_ids)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [pkg.test_id, String(name).trim(), pkg.providing_facility_id, effectiveDeadline, pkg.id,
         mode, participantFacilityIds ? JSON.stringify(participantFacilityIds) : null]
      );
    }
  }

  const freshPkg = await getPackage(pkg.id);
  const samples = await getSamples(pkg.id);
  res.json(camel(freshPkg, samples));
});

// POST /api/round-packages/:id/close — move a package from Active to Closed. All samples,
// results, participants, instructions, feedback and history are preserved untouched.
//
// Item 4: for any submission nobody has evaluated yet (feedback is still null), this also
// auto-runs consensus for its round right now. buildConsensusReport already marks a field
// "not_evaluated" whenever fewer than 3 facilities reported it (insufficientData) — closing
// a round is the natural point to lock that in, since no more results are coming. This never
// touches a submission a Facility Admin has already verified/authorized — auto-evaluation
// only fills in what was never looked at, so a round closing with no results in doesn't
// leave data hanging in fields that already were graded, and it never overrides admin
// judgement.
router.post('/:id/close', requireAuth, requireRole('facilityadmin', 'superadmin'), async (req, res) => {
  const pkg = await getPackage(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Round not found.' });
  if (req.user.role === 'facilityadmin' && pkg.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { rows } = await pool.query(
    `update round_packages set status = 'closed', closed_at = now(), closed_by = $1 where id = $2 returning *`,
    [req.user.id, pkg.id]
  );

  const children = await getSamples(pkg.id);
  for (const round of children) {
    const { rows: subRows } = await pool.query('select * from submissions where round_id = $1', [round.id]);
    const submissions = subRows.map(s => ({
      id: s.id, facilityId: s.facility_id, result: s.result, sampleAcceptability: s.sample_acceptability,
    }));
    if (submissions.length === 0) continue;
    const report = buildConsensusReport(round.test_id, submissions);
    if (report.error) continue;
    for (const entry of report.perSubmission) {
      const { rows: current } = await pool.query('select feedback from submissions where id = $1', [entry.submissionId]);
      if (current[0] && current[0].feedback) continue; // already evaluated by a human — never override
      const feedback = {
        status: entry.overall,
        comment: entry.comment,
        fields: entry.fields || {},
        fieldStats: report.fieldStats,
        verifiedBy: 'System (round closed automatically)',
        verifiedAt: new Date().toISOString(),
        authorizedBy: null,
        authorizedAt: null,
        released: false,
      };
      await pool.query('update submissions set feedback = $1 where id = $2', [feedback, entry.submissionId]);
    }
  }

  res.json(camel(rows[0], children));
});

// POST /api/round-packages/:id/reopen — admin error-recovery valve. Not destructive: no data
// was ever removed by closing, this just clears the closed flag so the round becomes active
// again (e.g. it was closed early by mistake).
router.post('/:id/reopen', requireAuth, requireRole('facilityadmin', 'superadmin'), async (req, res) => {
  const pkg = await getPackage(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Round not found.' });
  if (req.user.role === 'facilityadmin' && pkg.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { rows } = await pool.query(
    `update round_packages set status = 'active', closed_at = null, closed_by = null where id = $1 returning *`,
    [pkg.id]
  );
  res.json(camel(rows[0], await getSamples(pkg.id)));
});

// POST /api/round-packages/:id/request-deletion — Facility Admin can no longer delete a round
// directly; this instead notifies every active Super Admin so they can review and act.
router.post('/:id/request-deletion', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const pkg = await getPackage(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Round not found.' });
  if (pkg.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to request deletion.' });

  const { rows } = await pool.query(
    `update round_packages set deletion_requested_by = $1, deletion_requested_at = now(), deletion_request_reason = $2
     where id = $3 returning *`,
    [req.user.id, reason, pkg.id]
  );

  const { rows: admins } = await pool.query(
    `select email from users where role = 'superadmin' and status = 'active' and email is not null`
  );
  const { rows: facRows } = await pool.query('select name from facilities where id = $1', [req.user.facilityId]);
  const facilityName = facRows[0] ? facRows[0].name : 'Unknown facility';
  await Promise.all(admins.map(a => sendDeletionRequestEmail({
    to: a.email, requesterName: req.user.name, facilityName, roundLabel: packageLabel(pkg), reason,
  })));

  res.json(camel(rows[0], await getSamples(pkg.id)));
});

// POST /api/round-packages/:id/dismiss-deletion-request — Super Admin declines a pending
// request without deleting the round.
router.post('/:id/dismiss-deletion-request', requireAuth, requireRole('superadmin'), async (req, res) => {
  const pkg = await getPackage(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Round not found.' });
  const { rows } = await pool.query(
    `update round_packages set deletion_requested_by = null, deletion_requested_at = null, deletion_request_reason = null
     where id = $1 returning *`,
    [pkg.id]
  );
  res.json(camel(rows[0], await getSamples(pkg.id)));
});

// DELETE /api/round-packages/:id — Super Admin only. Unlike before, this is allowed even when
// labs have already submitted results — that's now a deliberate Super Admin power, not
// something a Facility Admin can trigger (they can only request-deletion, above). Deletes any
// submissions on this round's samples first so the foreign key never blocks the cleanup.
router.delete('/:id', requireAuth, requireRole('superadmin'), async (req, res) => {
  const pkg = await getPackage(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Round not found.' });
  const childIds = (await getSamples(pkg.id)).map(r => r.id);
  if (childIds.length) {
    await pool.query('delete from submissions where round_id = any($1::int[])', [childIds]);
  }
  await pool.query('delete from rounds where round_package_id = $1', [pkg.id]);
  await pool.query('delete from round_packages where id = $1', [pkg.id]);
  res.json({ message: 'Round deleted.' });
});

module.exports = router;
