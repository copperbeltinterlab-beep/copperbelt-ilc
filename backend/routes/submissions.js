const express = require('express');
const pool = require('../db');
const { buildConsensusReport } = require('../consensus');
const { getTestName, getTestDef, NOT_PERFORMED_REASONS } = require('../testDefinitions');
const { sendFeedbackReleasedEmail, sendFollowUpQueryEmail, sendQueryResponseEmail } = require('../email');
const { isEligibleParticipant } = require('../participation');
const { computeStatus, toDateOnly } = require('../roundPackageStatus');
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
    dateReceived: toDateOnly(s.date_received),
    methodUsed: s.method_used,
    sampleCondition: s.sample_condition,
    receivedBy: s.received_by,
    sampleAcceptability: s.sample_acceptability,
    sampleRejectionReason: s.sample_rejection_reason,
    resultStatus: s.result_status,
    result: s.result,
    personnelTesting: s.personnel_testing,
    personnelVerifying: s.personnel_verifying,
    testedByUserId: s.tested_by_user_id || null,
    verifiedByUserId: s.verified_by_user_id || null,
    status: s.status,
    savedAt: s.saved_at,
    submittedAt: s.submitted_at,
    feedback: s.feedback,
  };
}

// Dual-control columns + allow pending_verification status (safe to call repeatedly).
async function ensureDualControlSchema() {
  await pool.query(`
    alter table submissions add column if not exists tested_by_user_id integer;
    alter table submissions add column if not exists verified_by_user_id integer;
  `);
  // Relax status check to include pending_verification
  await pool.query(`
    do $$ begin
      alter table submissions drop constraint if exists submissions_status_check;
    exception when undefined_object then null;
    end $$;
  `);
  await pool.query(`
    do $$ begin
      alter table submissions
        add constraint submissions_status_check
        check (status in ('draft', 'pending_verification', 'submitted'));
    exception when duplicate_object then null;
    end $$;
  `);
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
  await ensureDualControlSchema();
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

  // action: 'draft' | 'submit_for_verification' | 'verify'
  // finalize:true is treated as submit_for_verification for backward compatibility.
  const action = (req.body.action || (req.body.finalize ? 'submit_for_verification' : 'draft')).trim();

  // Verifier step: second user locks the result. Analyst cannot verify their own entry.
  if (action === 'verify') {
    if (!existing || existing.status !== 'pending_verification') {
      return res.status(400).json({ error: 'This sample is not awaiting verification.' });
    }
    if (existing.tested_by_user_id && Number(existing.tested_by_user_id) === Number(req.user.id)) {
      return res.status(403).json({
        error: 'You entered these results as the analyst. A different user at your facility must log in and verify them.',
      });
    }
    const { rows } = await pool.query(
      `update submissions set
         status = 'submitted',
         personnel_verifying = $1,
         verified_by_user_id = $2,
         submitted_at = now(),
         saved_at = now()
       where id = $3 returning *`,
      [req.user.name, req.user.id, existing.id]
    );
    return res.json(camel(rows[0]));
  }

  // Pending verification: freeze edits until verified (or only the original analyst could re-open — we freeze).
  if (existing && existing.status === 'pending_verification' && action !== 'verify') {
    return res.status(403).json({
      error: 'Results are awaiting verification by another user and cannot be edited. Ask a colleague to verify, or contact your Facility Admin.',
    });
  }

  const {
    dateReceived, methodUsed, sampleCondition, receivedBy,
    sampleAcceptability, sampleRejectionReason,
  } = req.body;
  const result = sampleAcceptability === 'rejected' ? {} : req.body.result;

  const needsFullValidation = action === 'submit_for_verification';
  if (needsFullValidation) {
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
    if (!sampleAcceptability || !['accepted', 'rejected'].includes(sampleAcceptability)) {
      return res.status(400).json({ error: 'Indicate whether the sample was accepted or rejected before results can be submitted.' });
    }
    if (sampleAcceptability === 'rejected' && !(sampleRejectionReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when a sample is rejected.' });
    }
    if (sampleAcceptability === 'accepted') {
      // Validate result slots using same rules as before
      const testDef = getTestDef(round.test_id);
      if (testDef && result && typeof result === 'object') {
        const missing = [];
        for (const key of testDef.fields) {
          const v = result[key];
          if (!v || typeof v !== 'object') { missing.push(key); continue; }
          if (v.notPerformed || v.notApplicable) {
            if (v.notPerformed && !(v.reason || '').trim()) {
              return res.status(400).json({ error: `Select a reason for "Test Not Performed" (${key}).` });
            }
            continue;
          }
          if (v.value === null || v.value === undefined || v.value === '') missing.push(key);
        }
        // Bacterial growth: no growth → dependents not required
        if (round.test_id === 'bacterialgrowth' && result.growth && result.growth.value === 'No growth obtained') {
          ['gram', 'arrangement', 'bacterialId'].forEach(k => {
            const i = missing.indexOf(k);
            if (i >= 0) missing.splice(i, 1);
          });
        }
        if (missing.length) {
          return res.status(400).json({ error: `Every result slot is required before submitting. Missing: ${missing.join(', ')}.` });
        }
      }
    }
  }

  // Normalize not-performed reasons on any save
  let normalizedResult = result || {};
  if (normalizedResult && typeof normalizedResult === 'object') {
    for (const key of Object.keys(normalizedResult)) {
      const v = normalizedResult[key];
      if (v && typeof v === 'object' && v.notPerformed) {
        if (needsFullValidation && !(v.reason || '').trim()) {
          return res.status(400).json({ error: `Select a reason for "Test Not Performed" (${key}).` });
        }
        if (v.reason && !NOT_PERFORMED_REASONS.includes(v.reason)) {
          return res.status(400).json({ error: `Invalid Test Not Performed reason for ${key}.` });
        }
      }
    }
  }

  let status = 'draft';
  let personnelTesting = existing ? existing.personnel_testing : null;
  let personnelVerifying = existing ? existing.personnel_verifying : null;
  let testedByUserId = existing ? existing.tested_by_user_id : null;
  let verifiedByUserId = existing ? existing.verified_by_user_id : null;
  let submittedAt = existing ? existing.submitted_at : null;

  if (action === 'submit_for_verification') {
    status = 'pending_verification';
    personnelTesting = req.user.name;
    testedByUserId = req.user.id;
    personnelVerifying = null;
    verifiedByUserId = null;
    submittedAt = null;
  } else {
    status = 'draft';
  }

  // result_status is NOT NULL in the DB — never insert null.
  // "reported" = at least one real analyte value; "not_performed" = rejected or only NP/empty.
  let hasAnyRealValue = false;
  if (sampleAcceptability !== 'rejected' && normalizedResult && typeof normalizedResult === 'object') {
    for (const key of Object.keys(normalizedResult)) {
      const v = normalizedResult[key];
      if (!v || typeof v !== 'object') continue;
      if (v.notPerformed || v.notApplicable) continue;
      if (v.value !== null && v.value !== undefined && v.value !== '') {
        hasAnyRealValue = true;
        break;
      }
    }
  }
  const derivedResultStatus =
    sampleAcceptability === 'rejected' || !hasAnyRealValue ? 'not_performed' : 'reported';

  try {
    const { rows } = await pool.query(
      `insert into submissions
         (round_id, facility_id, date_received, method_used, sample_condition, received_by,
          sample_acceptability, sample_rejection_reason, result_status, result,
          personnel_testing, personnel_verifying, tested_by_user_id, verified_by_user_id,
          status, saved_at, submitted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16)
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
         tested_by_user_id = excluded.tested_by_user_id,
         verified_by_user_id = excluded.verified_by_user_id,
         status = excluded.status,
         saved_at = now(),
         submitted_at = excluded.submitted_at
       returning *`,
      [
        req.params.roundId, req.user.facilityId,
        dateReceived || null, methodUsed || null, sampleCondition || null, receivedBy || null,
        sampleAcceptability || null, sampleRejectionReason || null,
        derivedResultStatus, normalizedResult,
        personnelTesting, personnelVerifying, testedByUserId, verifiedByUserId,
        status, submittedAt,
      ]
    );
    res.json(camel(rows[0]));
  } catch (e) {
    console.error('Failed to save submission:', e.message);
    res.status(500).json({ error: e.message || 'Failed to save submission.' });
  }
});

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

// Ensure the queries table exists (safe to call repeatedly).
async function ensureQueriesTable() {
  await pool.query(`
    create table if not exists submission_queries (
      id serial primary key,
      round_id integer not null references rounds(id) on delete cascade,
      submission_id integer not null references submissions(id) on delete cascade,
      from_facility_id integer not null references facilities(id) on delete cascade,
      from_user_id integer references users(id) on delete set null,
      sample_id text,
      message text not null,
      created_at timestamptz not null default now(),
      read_at timestamptz,
      read_by integer references users(id) on delete set null
    )`);
  // Reply / audit trail columns (provider response back to the querying facility)
  await pool.query(`alter table submission_queries add column if not exists response_message text`);
  await pool.query(`alter table submission_queries add column if not exists responded_at timestamptz`);
  await pool.query(`alter table submission_queries add column if not exists responded_by integer references users(id) on delete set null`);
  await pool.query(`alter table submission_queries add column if not exists response_notified_at timestamptz`);
}

// POST /api/rounds/:roundId/submissions/:subId/query — Facility User follow-up about their
// own submission. Stored for in-app notification at the providing facility, and emailed.
router.post('/:roundId/submissions/:subId/query', requireAuth, requireRole('user', 'facilityadmin'), async (req, res) => {
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

  await ensureQueriesTable();
  await pool.query(
    `insert into submission_queries
       (round_id, submission_id, from_facility_id, from_user_id, sample_id, message)
     values ($1, $2, $3, $4, $5, $6)`,
    [round.id, submission.id, req.user.facilityId, req.user.id, round.sample_id || null, message]
  );

  const { rows: recipientRows } = await pool.query(
    `select email from users where facility_id = $1 and role = 'facilityadmin' and status = 'active' and email is not null`,
    [round.providing_facility_id]
  );

  const { rows: providerRows } = await pool.query('select name from facilities where id = $1', [round.providing_facility_id]);
  const providerName = providerRows[0] ? providerRows[0].name : 'the providing facility';

  if (recipientRows.length) {
    await Promise.all(recipientRows.map(r => sendFollowUpQueryEmail({
      to: r.email,
      personnelName: req.user.name,
      facilityName,
      messageBody: message,
      context: `${roundLabel(round)} — Sample ${round.sample_id || ''}`.trim(),
    })));
  }

  res.json({ message: `Your query has been sent to ${providerName}.` });
});

function mapQueryRow(q) {
  return {
    id: q.id,
    roundId: q.round_id,
    submissionId: q.submission_id,
    sampleId: q.sample_id || q.round_sample_id,
    testId: q.test_id,
    message: q.message,
    fromFacilityId: q.from_facility_id,
    fromFacilityName: q.from_facility_name,
    fromFacilityCode: q.from_facility_code || null,
    fromUserName: q.from_user_name,
    createdAt: q.created_at,
    readAt: q.read_at,
    unread: !q.read_at,
    responseMessage: q.response_message || null,
    respondedAt: q.responded_at || null,
    respondedByName: q.responded_by_name || null,
    hasResponse: !!q.response_message,
  };
}

// GET /api/rounds/queries/inbox — providing Facility Admin inbox
// Query params: status=unread|read|all (default all), facilityId= optional filter by sender facility
router.get('/queries/inbox', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  await ensureQueriesTable();
  const status = String(req.query.status || 'all').toLowerCase();
  const facilityId = req.query.facilityId ? Number(req.query.facilityId) : null;

  const params = [req.user.facilityId];
  let where = 'r.providing_facility_id = $1';
  if (status === 'unread') where += ' and q.read_at is null';
  else if (status === 'read') where += ' and q.read_at is not null';
  if (facilityId) {
    params.push(facilityId);
    where += ` and q.from_facility_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `select q.*, r.sample_id as round_sample_id, r.test_id, r.providing_facility_id,
            f.name as from_facility_name, f.facility_code as from_facility_code,
            u.name as from_user_name, ru.name as responded_by_name
     from submission_queries q
     join rounds r on r.id = q.round_id
     left join facilities f on f.id = q.from_facility_id
     left join users u on u.id = q.from_user_id
     left join users ru on ru.id = q.responded_by
     where ${where}
     order by q.created_at desc
     limit 200`,
    params
  );
  res.json(rows.map(mapQueryRow));
});

// GET /api/rounds/queries/sent — queries sent by my facility (participating lab) + provider replies
router.get('/queries/sent', requireAuth, requireRole('user', 'facilityadmin'), async (req, res) => {
  await ensureQueriesTable();
  if (!req.user.facilityId) return res.json([]);
  const { rows } = await pool.query(
    `select q.*, r.sample_id as round_sample_id, r.test_id, r.providing_facility_id,
            f.name as from_facility_name, f.facility_code as from_facility_code,
            u.name as from_user_name, ru.name as responded_by_name,
            pf.name as provider_facility_name
     from submission_queries q
     join rounds r on r.id = q.round_id
     left join facilities f on f.id = q.from_facility_id
     left join facilities pf on pf.id = r.providing_facility_id
     left join users u on u.id = q.from_user_id
     left join users ru on ru.id = q.responded_by
     where q.from_facility_id = $1
     order by q.created_at desc
     limit 100`,
    [req.user.facilityId]
  );
  res.json(rows.map(q => ({
    ...mapQueryRow(q),
    providerFacilityName: q.provider_facility_name || null,
  })));
});

// POST /api/rounds/queries/:id/read — mark a query as read (provider inbox)
router.post('/queries/:id/read', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  await ensureQueriesTable();
  const { rows } = await pool.query(
    `update submission_queries q
       set read_at = now(), read_by = $1
      from rounds r
     where q.id = $2 and q.round_id = r.id and r.providing_facility_id = $3
     returning q.*`,
    [req.user.id, req.params.id, req.user.facilityId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Query not found.' });
  res.json({ ok: true });
});

// POST /api/rounds/queries/:id/respond — providing Facility Admin replies (audit trail)
router.post('/queries/:id/respond', requireAuth, requireRole('facilityadmin'), async (req, res) => {
  await ensureQueriesTable();
  const responseMessage = (req.body.responseMessage || req.body.message || '').trim();
  if (!responseMessage) return res.status(400).json({ error: 'Enter a response before sending.' });
  if (responseMessage.length > MAX_QUERY_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Response is too long (max ${MAX_QUERY_MESSAGE_LENGTH} characters).` });
  }

  const { rows: qRows } = await pool.query(
    `select q.*, r.sample_id as round_sample_id, r.test_id, r.providing_facility_id
     from submission_queries q
     join rounds r on r.id = q.round_id
     where q.id = $1`,
    [req.params.id]
  );
  const q = qRows[0];
  if (!q) return res.status(404).json({ error: 'Query not found.' });
  if (q.providing_facility_id !== req.user.facilityId) {
    return res.status(403).json({ error: 'You can only respond to queries for rounds your facility provides.' });
  }
  if (q.response_message) {
    return res.status(409).json({ error: 'This query already has a response. Contact Super Admin if a correction is needed.' });
  }

  const { rows: updated } = await pool.query(
    `update submission_queries
        set response_message = $1,
            responded_at = now(),
            responded_by = $2,
            read_at = coalesce(read_at, now()),
            read_by = coalesce(read_by, $2),
            response_notified_at = now()
      where id = $3
      returning *`,
    [responseMessage, req.user.id, q.id]
  );

  // Notify ALL active users at the facility that sent the query (traceability / update)
  const { rows: recipients } = await pool.query(
    `select name, email from users
      where facility_id = $1 and status = 'active' and email is not null`,
    [q.from_facility_id]
  );
  const { rows: providerFac } = await pool.query('select name from facilities where id = $1', [req.user.facilityId]);
  const providerName = providerFac[0] ? providerFac[0].name : 'Providing facility';
  const context = `${getTestName(q.test_id)} — Sample ${q.sample_id || q.round_sample_id || ''}`.trim();

  if (recipients.length && typeof sendQueryResponseEmail === 'function') {
    await Promise.all(recipients.map(r => sendQueryResponseEmail({
      to: r.email,
      recipientName: r.name,
      providerFacilityName: providerName,
      responseBody: responseMessage,
      context,
    }).catch(err => console.error('Query response email failed:', err.message))));
  }

  res.json({
    message: `Response sent. ${recipients.length} user(s) at the querying facility will be notified.`,
    query: mapQueryRow({ ...updated[0], round_sample_id: q.round_sample_id, test_id: q.test_id }),
  });
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
