const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function camel(s) {
  return {
    id: s.id,
    roundId: s.round_id,
    facilityId: s.facility_id,
    dateReceived: s.date_received,
    methodUsed: s.method_used,
    sampleCondition: s.sample_condition,
    sampleAcceptability: s.sample_acceptability,
    sampleRejectionReason: s.sample_rejection_reason,
    resultStatus: s.result_status,
    notPerformedReason: s.not_performed_reason,
    result: s.result,
    personnelTesting: s.personnel_testing,
    personnelVerifying: s.personnel_verifying,
    status: s.status,
    savedAt: s.saved_at,
    submittedAt: s.submitted_at,
    feedback: s.feedback,
  };
}

async function getRound(roundId) {
  const { rows } = await pool.query('select * from rounds where id = $1', [roundId]);
  return rows[0];
}

// GET /api/rounds/:roundId/submissions
// Facility Admin only, and only for a round THEIR facility provides (so they can grade it).
router.get('/:roundId/submissions', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (round.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { rows } = await pool.query('select * from submissions where round_id = $1', [req.params.roundId]);
  res.json(rows.map(camel));
});

// GET /api/rounds/:roundId/submissions/mine — a Facility User's own draft/submission for a round
router.get('/:roundId/submissions/mine', requireAuth, requireRole('user'), async (req, res) => {
  const { rows } = await pool.query(
    'select * from submissions where round_id = $1 and facility_id = $2',
    [req.params.roundId, req.user.facilityId]
  );
  res.json(rows[0] ? camel(rows[0]) : null);
});

// PUT /api/rounds/:roundId/submissions/mine — save draft or submit final result
router.put('/:roundId/submissions/mine', requireAuth, requireRole('user'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });

  const deadlinePassed = new Date(round.deadline + 'T23:59:59') < new Date();
  if (deadlinePassed) return res.status(403).json({ error: 'This round is closed.' });

  const { rows: existingRows } = await pool.query(
    'select * from submissions where round_id = $1 and facility_id = $2',
    [req.params.roundId, req.user.facilityId]
  );
  const existing = existingRows[0];
  if (existing && existing.status === 'submitted') {
    return res.status(403).json({ error: 'Already submitted — this result is locked.' });
  }

  const {
    dateReceived, methodUsed, sampleCondition,
    sampleAcceptability, sampleRejectionReason,
    resultStatus, notPerformedReason,
    result, personnelTesting, personnelVerifying, finalize,
  } = req.body;

  if (finalize) {
    if (!personnelTesting || !personnelVerifying) {
      return res.status(400).json({ error: 'Enter both tested-by and verified-by names before final submission.' });
    }
    if (!methodUsed || !methodUsed.trim()) {
      return res.status(400).json({ error: 'Method used is required before final submission.' });
    }
    if (!['accepted', 'rejected'].includes(sampleAcceptability)) {
      return res.status(400).json({ error: 'Indicate whether the sample was accepted or rejected on receipt.' });
    }
    if (sampleAcceptability === 'rejected' && !(sampleRejectionReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when a sample is rejected.' });
    }
    if (!['reported', 'not_performed'].includes(resultStatus)) {
      return res.status(400).json({ error: 'Indicate whether a result was reported or the test was not performed.' });
    }
    if (resultStatus === 'not_performed' && !(notPerformedReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when a test was not performed.' });
    }
    if (resultStatus === 'reported' && (!result || Object.keys(result).length === 0)) {
      return res.status(400).json({ error: 'Enter a result, or mark the test as not performed.' });
    }
  }

  const status = finalize ? 'submitted' : 'draft';
  const submittedAt = finalize ? new Date().toISOString() : (existing ? existing.submitted_at : null);

  const { rows } = await pool.query(
    `insert into submissions
       (round_id, facility_id, date_received, method_used, sample_condition,
        sample_acceptability, sample_rejection_reason, result_status, not_performed_reason,
        result, personnel_testing, personnel_verifying, status, saved_at, submitted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14)
     on conflict (round_id, facility_id) do update set
       date_received = excluded.date_received,
       method_used = excluded.method_used,
       sample_condition = excluded.sample_condition,
       sample_acceptability = excluded.sample_acceptability,
       sample_rejection_reason = excluded.sample_rejection_reason,
       result_status = excluded.result_status,
       not_performed_reason = excluded.not_performed_reason,
       result = excluded.result,
       personnel_testing = excluded.personnel_testing,
       personnel_verifying = excluded.personnel_verifying,
       status = excluded.status,
       saved_at = now(),
       submitted_at = excluded.submitted_at
     returning *`,
    [req.params.roundId, req.user.facilityId, dateReceived || null, methodUsed || null,
     sampleCondition || null, sampleAcceptability || null, sampleRejectionReason || null,
     resultStatus || 'reported', notPerformedReason || null,
     result || {}, personnelTesting || null, personnelVerifying || null,
     status, submittedAt]
  );
  res.json(camel(rows[0]));
});

// GET /api/my-feedback — a Facility User's own submitted results + feedback, across all rounds
router.get('/mine/feedback', requireAuth, requireRole('user'), async (req, res) => {
  const { rows } = await pool.query(
    `select * from submissions where facility_id = $1 and status = 'submitted' order by submitted_at desc`,
    [req.user.facilityId]
  );
  res.json(rows.map(camel));
});

// POST /api/rounds/:roundId/submissions/:subId/feedback — Facility Admin evaluates a result
router.post('/:roundId/submissions/:subId/feedback', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (round.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { status, comment } = req.body;
  if (!['acceptable', 'unacceptable', 'not_evaluated'].includes(status)) {
    return res.status(400).json({ error: 'Invalid feedback status.' });
  }
  const feedback = status === 'not_evaluated'
    ? null
    : { status, comment: comment || '', evaluatedBy: req.user.name, evaluatedAt: new Date().toISOString() };
  const { rows } = await pool.query(
    `update submissions set feedback = $1 where id = $2 and round_id = $3 returning *`,
    [feedback, req.params.subId, req.params.roundId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Submission not found.' });
  res.json(camel(rows[0]));
});

// PATCH /api/rounds/:roundId/deadline — Facility Admin extends/reduces the deadline
// for a round THEIR facility provides. Keeps a visible audit trail of every change.
router.patch('/:roundId/deadline', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (round.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { newDeadline, reason } = req.body;
  if (!newDeadline) return res.status(400).json({ error: 'A new deadline date is required.' });
  if (!(reason || '').trim()) return res.status(400).json({ error: 'A reason is required when changing a deadline.' });

  const historyEntry = {
    previousDeadline: round.deadline,
    newDeadline,
    reason: reason.trim(),
    changedBy: req.user.name,
    changedAt: new Date().toISOString(),
  };
  const history = Array.isArray(round.deadline_history) ? round.deadline_history : [];
  history.push(historyEntry);

  const { rows } = await pool.query(
    'update rounds set deadline = $1, deadline_history = $2 where id = $3 returning *',
    [newDeadline, JSON.stringify(history), req.params.roundId]
  );
  const r = rows[0];
  res.json({
    id: r.id, testId: r.test_id, sampleId: r.sample_id,
    providingFacilityId: r.providing_facility_id, deadline: r.deadline,
    deadlineHistory: r.deadline_history,
  });
});

module.exports = router;
