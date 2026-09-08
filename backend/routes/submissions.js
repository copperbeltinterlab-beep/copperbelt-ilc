const express = require('express');
const pool = require('../db');
const { buildConsensusReport } = require('../consensus');
const { getTestName, getTestDef, NOT_PERFORMED_REASONS } = require('../testDefinitions');
const { sendFeedbackReleasedEmail, sendFollowUpQueryEmail } = require('../email');
const { isEligibleParticipant } = require('../participation');
const { computeStatus } = require('../roundPackageStatus');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const MAX_QUERY_MESSAGE_LENGTH = 2000;

// Human-readable "Test Name — Sample X" label used in email notifications.
function roundLabel(round) {
  return `${getTestName(round.test_id)} — Sample ${round.sample_id}`;
}

function camel(s) {
  return {
    id: s.id,
    roundId: s.round_id,
    facilityId: s.facility_id,
    dateReceived: s.date_received,
    methodUsed: s.method_used,
    sampleCondition: s.sample_condition,
    receivedBy: s.received_by,
    sampleAcceptability: s.sample_acceptability,
    sampleRejectionReason: s.sample_rejection_reason,
    resultStatus: s.result_status,
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

// PUT /api/rounds/:roundId/submissions/mine — save draft or submit final result.
// Facility Users only — this is laboratory result entry, not an admin function.
router.put('/:roundId/submissions/mine', requireAuth, requireRole('user'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (!isEligibleParticipant(round, req.user.facilityId)) {
    return res.status(403).json({ error: 'Your facility is not a participant in this round.' });
  }

  const deadlineDateOnly = round.deadline instanceof Date ? round.deadline.toISOString().slice(0, 10) : String(round.deadline).slice(0, 10);
  const deadlinePassed = new Date(deadlineDateOnly + 'T23:59:59') < new Date();
  if (deadlinePassed) return res.status(403).json({ error: 'This round is closed.' });

  if (round.round_package_id) {
    const { rows: pkgRows } = await pool.query('select * from round_packages where id = $1', [round.round_package_id]);
    const pkg = pkgRows[0];
    if (pkg && computeStatus(pkg) === 'closed') {
      return res.status(403).json({ error: 'This round is closed.' });
    }
  }

  const { rows: existingRows } = await pool.query(
    'select * from submissions where round_id = $1 and facility_id = $2',
    [req.params.roundId, req.user.facilityId]
  );
  const existing = existingRows[0];
  if (existing && existing.status === 'submitted') {
    return res.status(403).json({ error: 'Already submitted — this result is locked.' });
  }

  const {
    dateReceived, methodUsed, sampleCondition, receivedBy,
    sampleAcceptability, sampleRejectionReason,
    personnelTesting, personnelVerifying, finalize,
  } = req.body;
  // A rejected sample was never tested — never trust the client to have left the result
  // object empty; a rejected sample can never carry result data no matter what is sent.
  const result = sampleAcceptability === 'rejected' ? {} : req.body.result;

  if (finalize) {
    if (!dateReceived) {
      return res.status(400).json({ error: 'Date sample received is required before final submission.' });
    }
    if (!methodUsed || !methodUsed.trim()) {
      return res.status(400).json({ error: 'Method/instrument used is required before final submission.' });
    }
    if (!sampleCondition || !sampleCondition.trim()) {
      return res.status(400).json({ error: 'Sample Receipt: Condition is required before final submission.' });
    }
    if (!receivedBy || !receivedBy.trim()) {
      return res.status(400).json({ error: 'Received By is required before final submission.' });
    }
    if (!['accepted', 'rejected'].includes(sampleAcceptability)) {
      return res.status(400).json({ error: 'Indicate whether the sample was accepted or rejected before results can be submitted.' });
    }
    if (sampleAcceptability === 'rejected' && !(sampleRejectionReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when a sample is rejected.' });
    }
    // A rejected sample has no analytes to test — the mandatory-slots check only applies once
    // the sample has actually been accepted for testing.
    if (sampleAcceptability === 'accepted') {
      if (!personnelTesting || !personnelVerifying) {
        return res.status(400).json({ error: 'Enter both tested-by and results-authorized-by names before final submission.' });
      }
      const testDef = getTestDef(round.test_id);
      const missingLabels = [];
      if (testDef) {
        for (const key of testDef.fields) {
          const raw = result ? result[key] : undefined;
          const hasValue = raw && typeof raw === 'object'
            ? (raw.notPerformed ? true : (raw.value !== null && raw.value !== undefined && raw.value !== ''))
            : (raw !== null && raw !== undefined && raw !== '');
          if (!hasValue) missingLabels.push(key);
        }
      }
      if (missingLabels.length) {
        return res.status(400).json({ error: `Every result slot is required before submitting. Missing: ${missingLabels.join(', ')}.` });
      }
    }
  }

  // Test Not Performed always requires one of the four approved reasons — enforced here
  // regardless of finalize, so a draft save can't carry an incomplete not-performed field
  // either. Any field NOT marked not-performed has its reason normalized to null server-side,
  // so a result that's since been filled in can never keep a stale, contradictory reason.
  const normalizedResult = {};
  if (result && typeof result === 'object') {
    for (const [key, raw] of Object.entries(result)) {
      if (raw && typeof raw === 'object' && 'notPerformed' in raw) {
        if (raw.notPerformed) {
          if (!NOT_PERFORMED_REASONS.includes(raw.reason)) {
            return res.status(400).json({ error: `Select a reason for "Test Not Performed" (${key}).` });
          }
          normalizedResult[key] = { value: null, notPerformed: true, reason: raw.reason };
        } else {
          normalizedResult[key] = { value: raw.value ?? null, notPerformed: false, reason: null };
        }
      } else {
        normalizedResult[key] = raw;
      }
    }
  }

  // Derive an internal reported/not_performed summary (used for consensus/statistics later) —
  // this is computed automatically, never chosen directly by the lab.
  const hasAnyRealValue = Object.values(normalizedResult).some(v => {
    if (v && typeof v === 'object') return v.value !== null && v.value !== undefined && v.value !== '' && !v.notPerformed;
    return v !== null && v !== undefined && v !== '';
  });
  const derivedResultStatus = (sampleAcceptability === 'rejected' || !hasAnyRealValue) ? 'not_performed' : 'reported';

  const status = finalize ? 'submitted' : 'draft';
  const submittedAt = finalize ? new Date().toISOString() : (existing ? existing.submitted_at : null);

  const { rows } = await pool.query(
    `insert into submissions
       (round_id, facility_id, date_received, method_used, sample_condition, received_by,
        sample_acceptability, sample_rejection_reason,
        result_status, result, personnel_testing, personnel_verifying, status, saved_at, submitted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14)
     on conflict (round_id, facility_id) do update set
       date_received = excluded.date_received,
       method_used = excluded.method_used,
       sample_condition = excluded.sample_condition,
       received_by = excluded.received_by,
       sample_acceptability = excluded.sample_acceptability,
       sample_rejection_reason = excluded.sample_rejection_reason,
       result_status = excluded.result_status,
       result = excluded.result,
       personnel_testing = excluded.personnel_testing,
       personnel_verifying = excluded.personnel_verifying,
       status = excluded.status,
       saved_at = now(),
       submitted_at = excluded.submitted_at
     returning *`,
    [req.params.roundId, req.user.facilityId, dateReceived || null, methodUsed || null,
     sampleCondition || null, receivedBy || null, sampleAcceptability || null, sampleRejectionReason || null,
     derivedResultStatus, normalizedResult, personnelTesting || null, personnelVerifying || null,
     status, submittedAt]
  );
  res.json(camel(rows[0]));
});

// GET /api/rounds/mine/status — a Facility User's submission status (submitted / draft / none)
// across every round, so Active Rounds can show "Results Submitted" / "Results Not Submitted".
router.get('/mine/status', requireAuth, requireRole('user'), async (req, res) => {
  const { rows } = await pool.query(
    'select round_id, status from submissions where facility_id = $1',
    [req.user.facilityId]
  );
  const map = {};
  rows.forEach(r => { map[r.round_id] = r.status; }); // 'submitted' or 'draft'
  res.json(map);
});

// GET /api/rounds/mine/feedback — a Facility User's own submitted results + feedback, across all rounds.
// Only shows feedback that has been fully authorized (dual sign-off complete) — a verified-only
// result is still under internal review and stays hidden from the submitting facility until then.
router.get('/mine/feedback', requireAuth, requireRole('user'), async (req, res) => {
  const { rows } = await pool.query(
    `select * from submissions where facility_id = $1 and status = 'submitted' order by submitted_at desc`,
    [req.user.facilityId]
  );
  const visible = rows.map(camel).map(s => {
    if (s.feedback && !s.feedback.released) {
      return { ...s, feedback: null }; // hide unreleased (verified-but-not-yet-authorized) feedback
    }
    return s;
  });
  res.json(visible);
});

// POST /api/rounds/:roundId/submissions/:subId/query — a Facility User sends a follow-up
// question about their own submission/feedback to the Facility Admins at the facility that
// provides this round (the ones who verify/authorize it). This is a direct email relay —
// nothing is stored server-side, it's a message, not a ticket.
router.post('/:roundId/submissions/:subId/query', requireAuth, requireRole('user'), async (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Enter a message before sending.' });
  if (message.length > MAX_QUERY_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_QUERY_MESSAGE_LENGTH} characters).` });
  }

  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });

  const { rows: subRows } = await pool.query(
    'select * from submissions where id = $1 and round_id = $2',
    [req.params.subId, req.params.roundId]
  );
  const submission = subRows[0];
  if (!submission) return res.status(404).json({ error: 'Submission not found.' });
  if (submission.facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'You can only send a query about your own facility\'s submission.' });
  }

  const { rows: facRows } = await pool.query('select name from facilities where id = $1', [req.user.facilityId]);
  const facilityName = facRows[0] ? facRows[0].name : 'Unknown facility';

  const { rows: recipientRows } = await pool.query(
    `select email from users where facility_id = $1 and role = 'facilityadmin' and status = 'active' and email is not null`,
    [round.providing_facility_id]
  );
  if (recipientRows.length === 0) {
    return res.status(400).json({ error: 'No administrator contact is currently available for this round\'s facility.' });
  }

  const { rows: providerRows } = await pool.query('select name from facilities where id = $1', [round.providing_facility_id]);
  const providerName = providerRows[0] ? providerRows[0].name : 'the providing facility';

  await Promise.all(recipientRows.map(r => sendFollowUpQueryEmail({
    to: r.email,
    personnelName: req.user.name,
    facilityName,
    messageBody: message,
    context: roundLabel(round),
  })));

  res.json({ message: `Your query has been sent to ${providerName}.` });
});

// POST /api/rounds/:roundId/submissions/:subId/feedback — Facility Admin evaluates a result.
// Two-person sign-off: one admin "verifies" (records a provisional assessment), then a
// DIFFERENT admin at the same facility "authorizes" it, which releases it to the submitting
// facility. This mirrors the verified-by / authorized-by dual-control used in accredited labs.
router.post('/:roundId/submissions/:subId/feedback', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (round.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { action, status, comment } = req.body;

  const { rows: subRows } = await pool.query(
    'select * from submissions where id = $1 and round_id = $2',
    [req.params.subId, req.params.roundId]
  );
  const existing = subRows[0];
  if (!existing) return res.status(404).json({ error: 'Submission not found.' });
  const existingFeedback = existing.feedback || {};

  if (action === 'authorize') {
    if (!existingFeedback.verifiedBy) {
      return res.status(400).json({ error: 'This result must be verified before it can be authorized.' });
    }
    if (existingFeedback.verifiedBy === req.user.name) {
      return res.status(403).json({ error: 'A different Facility Admin must authorize this — the same person cannot both verify and authorize.' });
    }
    const feedback = {
      ...existingFeedback,
      authorizedBy: req.user.name,
      authorizedAt: new Date().toISOString(),
      released: true,
    };
    const { rows } = await pool.query(
      `update submissions set feedback = $1 where id = $2 and round_id = $3 returning *`,
      [feedback, req.params.subId, req.params.roundId]
    );

    // Notify the submitting facility's users now that feedback is visible to them.
    // Never let an email hiccup affect the response — sendFeedbackReleasedEmail/sendMail
    // already swallow their own errors, but we double-guard here regardless.
    try {
      const { rows: recipientRows } = await pool.query(
        `select name, email from users where facility_id = $1 and role = 'user' and status = 'active' and email is not null`,
        [existing.facility_id]
      );
      const label = roundLabel(round);
      await Promise.all(recipientRows.map(u => sendFeedbackReleasedEmail({ to: u.email, name: u.name, roundLabel: label })));
    } catch (e) {
      console.error('Failed to send feedback-released notification:', e.message);
    }

    return res.json(camel(rows[0]));
  }

  // Default action: 'verify' (or omitted, for backward compatibility)
  if (!['acceptable', 'unacceptable', 'not_evaluated'].includes(status)) {
    return res.status(400).json({ error: 'Invalid feedback status.' });
  }
  if (status === 'not_evaluated') {
    const { rows } = await pool.query(
      `update submissions set feedback = null where id = $1 and round_id = $2 returning *`,
      [req.params.subId, req.params.roundId]
    );
    return res.json(camel(rows[0]));
  }
  const feedback = {
    status,
    comment: comment || '',
    verifiedBy: req.user.name,
    verifiedAt: new Date().toISOString(),
    authorizedBy: null,
    authorizedAt: null,
    released: false,
  };
  const { rows } = await pool.query(
    `update submissions set feedback = $1 where id = $2 and round_id = $3 returning *`,
    [feedback, req.params.subId, req.params.roundId]
  );
  res.json(camel(rows[0]));
});

// PATCH /api/rounds/:roundId/deadline — extend/reduce a round's deadline.
// Facility Admins may only do this for rounds THEIR facility provides.
// Super Admins may do this for ANY round (oversight of all ILC rounds), but — per
// policy — Super Admins cannot create rounds (see rounds.js: only facilityadmin can POST).
// Every change is logged to a visible audit trail regardless of who made it.
router.patch('/:roundId/deadline', requireAuth, requireRole('facilityadmin', 'superadmin'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (req.user.role === 'facilityadmin' && round.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { newDeadline, reason } = req.body;
  if (!newDeadline) return res.status(400).json({ error: 'A new deadline date is required.' });
  if (!(reason || '').trim()) return res.status(400).json({ error: 'A reason is required when changing a deadline.' });

  const historyEntry = {
    previousDeadline: round.deadline instanceof Date ? round.deadline.toISOString().slice(0, 10) : String(round.deadline).slice(0, 10),
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
    providingFacilityId: r.providing_facility_id,
    deadline: r.deadline instanceof Date ? r.deadline.toISOString().slice(0, 10) : String(r.deadline).slice(0, 10),
    deadlineHistory: r.deadline_history,
  });
});

// GET /api/rounds/:roundId/consensus — compute (without saving) the consensus statistics
// and suggested per-submission verdicts for a round. Facility Admin only, providing facility only.
router.get('/:roundId/consensus', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (round.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { rows: subRows } = await pool.query(
    `select * from submissions where round_id = $1 and status = 'submitted'`,
    [req.params.roundId]
  );
  const submissions = subRows.map(camel);
  const report = buildConsensusReport(round.test_id, submissions);
  if (report.error) return res.status(400).json(report);

  // Facilities expected to participate (everyone except the facility providing this round)
  // who never submitted anything at all — distinct from a submission that came in "rejected".
  const { rows: facilityRows } = await pool.query(
    'select id, name from facilities where id != $1 and active = true order by name',
    [round.providing_facility_id]
  );
  const submittedFacilityIds = new Set(submissions.map(s => s.facilityId));
  const notSubmitted = facilityRows.filter(f => !submittedFacilityIds.has(f.id)).map(f => ({ facilityId: f.id, facilityName: f.name }));

  res.json({ ...report, notSubmitted });
});

// POST /api/rounds/:roundId/consensus/apply — compute the consensus and write it as the
// "Verify" step for every submitted result in this round (same effect as manually verifying
// each one, just done in bulk). A DIFFERENT Facility Admin must still Authorize & Release
// each one afterward — this endpoint never releases feedback by itself.
router.post('/:roundId/consensus/apply', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  const round = await getRound(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  if (round.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'This round belongs to another facility.' });
  }
  const { rows: subRows } = await pool.query(
    `select * from submissions where round_id = $1 and status = 'submitted'`,
    [req.params.roundId]
  );
  const submissions = subRows.map(camel);
  const report = buildConsensusReport(round.test_id, submissions);
  if (report.error) return res.status(400).json(report);

  const updated = [];
  for (const entry of report.perSubmission) {
    const feedback = {
      status: entry.overall,
      comment: entry.comment,
      fields: entry.fields || {},
      fieldStats: report.fieldStats,
      verifiedBy: req.user.name,
      verifiedAt: new Date().toISOString(),
      authorizedBy: null,
      authorizedAt: null,
      released: false,
    };
    const { rows } = await pool.query(
      'update submissions set feedback = $1 where id = $2 returning *',
      [feedback, entry.submissionId]
    );
    updated.push(camel(rows[0]));
  }
  res.json({ fieldStats: report.fieldStats, updatedSubmissions: updated });
});

module.exports = router;
