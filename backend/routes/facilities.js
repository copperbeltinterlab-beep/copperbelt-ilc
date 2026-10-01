const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function camel(f) {
  return {
    id: f.id,
    name: f.name,
    town: f.town,
    facilityType: f.facility_type,
    facilityCode: f.facility_code || null,
    active: f.active,
    // When false, Facility Admins at this lab cannot create ILC rounds (participant-only).
    canProvideRounds: f.can_provide_rounds !== false,
  };
}

async function ensureFacilityCodeSchema() {
  await pool.query(`
    alter table facilities add column if not exists facility_code text;
  `);
  // Participant-only labs: Super Admin can turn off round creation for Facility Admins.
  await pool.query(`
    alter table facilities add column if not exists can_provide_rounds boolean not null default true;
  `);
  await pool.query(`
    create unique index if not exists facilities_facility_code_uidx
      on facilities (facility_code) where facility_code is not null;
  `);

  // Seed fixed codes for existing named facilities (only if that code is free / row has no code)
  const seeds = [
    ['CB001', 'Kitwe Teaching Hospital'],
    ['CB002', 'Ndola Teaching Hospital'],
    ['CB003', 'Nchanga North General Hospital'],
    ['CB004', 'Kalulushi General Hospital'],
  ];
  for (const [code, name] of seeds) {
    // Assign code to matching facility name if it has no code yet and code is unused
    await pool.query(
      `update facilities f
          set facility_code = $1
        where f.facility_code is null
          and lower(trim(f.name)) = lower(trim($2))
          and not exists (
            select 1 from facilities x where x.facility_code = $1
          )`,
      [code, name]
    );
  }

  // Any other existing facilities without a code get the next free CB### (reuses gaps)
  const { rows: uncoded } = await pool.query(
    'select id from facilities where facility_code is null order by id'
  );
  for (const row of uncoded) {
    const code = await allocateFacilityCode(pool);
    await pool.query('update facilities set facility_code = $1 where id = $2 and facility_code is null', [
      code,
      row.id,
    ]);
  }
}

/** Next free CB### — reuses gaps left by deleted facilities. */
async function allocateFacilityCode(client) {
  const q = client || pool;
  const { rows } = await q.query(
    `select facility_code from facilities where facility_code ~ '^CB[0-9]{3}$'`
  );
  const used = new Set(
    rows.map(r => parseInt(String(r.facility_code).replace(/^CB/i, ''), 10)).filter(n => !isNaN(n))
  );
  let n = 1;
  while (used.has(n)) n += 1;
  if (n > 999) throw new Error('Facility code space CB001–CB999 is full.');
  return 'CB' + String(n).padStart(3, '0');
}

// GET /api/facilities/public — active facilities for the public home page (no auth)
router.get('/public', async (req, res) => {
  await ensureFacilityCodeSchema();
  const { rows } = await pool.query(
    'select name, town, facility_type, facility_code from facilities where active = true order by facility_code nulls last, name'
  );
  res.json(rows.map(f => ({
    name: f.name,
    town: f.town,
    facilityType: f.facility_type,
    facilityCode: f.facility_code || null,
  })));
});

// GET /api/facilities
router.get('/', requireAuth, async (req, res) => {
  await ensureFacilityCodeSchema();
  const { rows } = await pool.query(
    'select * from facilities order by facility_code nulls last, name'
  );
  res.json(rows.map(camel));
});

// POST /api/facilities — Super Admin
router.post('/', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureFacilityCodeSchema();
  const { name, town, facilityType } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Facility name is required.' });
  if (facilityType && !['government', 'private'].includes(facilityType)) {
    return res.status(400).json({ error: 'Facility type must be government or private.' });
  }

  const trimmedName = name.trim();
  // Case-insensitive duplicate name check (e.g. "Kitwe Teaching Hospital" vs "kitwe teaching hospital")
  const { rows: nameDupes } = await pool.query(
    `select id, name, facility_code from facilities
      where lower(trim(name)) = lower(trim($1))
      limit 1`,
    [trimmedName]
  );
  if (nameDupes.length) {
    const d = nameDupes[0];
    return res.status(409).json({
      error: `A facility with this name already exists${d.facility_code ? ` (${d.facility_code})` : ''}: "${d.name}".`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const code = await allocateFacilityCode(client);
    const { rows } = await client.query(
      `insert into facilities (name, town, facility_type, facility_code)
       values ($1, $2, $3, $4) returning *`,
      [trimmedName, town || null, facilityType || 'government', code]
    );
    await client.query('commit');
    res.status(201).json(camel(rows[0]));
  } catch (e) {
    await client.query('rollback');
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Facility code or name conflict — try again.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Could not create facility.' });
  } finally {
    client.release();
  }
});

// PATCH /api/facilities/:id
router.patch('/:id', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureFacilityCodeSchema();
  const { name, town, facilityType, canProvideRounds } = req.body;
  const { rows: existingRows } = await pool.query('select * from facilities where id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Facility not found.' });
  if (facilityType && !['government', 'private'].includes(facilityType)) {
    return res.status(400).json({ error: 'Facility type must be government or private.' });
  }
  // facility_code is immutable while the facility exists
  const nextName = (name && name.trim()) ? name.trim() : existing.name;
  if (nextName !== existing.name) {
    const { rows: nameDupes } = await pool.query(
      `select id, name, facility_code from facilities
        where lower(trim(name)) = lower(trim($1)) and id <> $2
        limit 1`,
      [nextName, req.params.id]
    );
    if (nameDupes.length) {
      const d = nameDupes[0];
      return res.status(409).json({
        error: `Another facility already uses this name${d.facility_code ? ` (${d.facility_code})` : ''}: "${d.name}".`,
      });
    }
  }

  const nextCanProvide = canProvideRounds === undefined
    ? (existing.can_provide_rounds !== false)
    : !!canProvideRounds;

  const { rows } = await pool.query(
    `update facilities set name = $1, town = $2, facility_type = $3, can_provide_rounds = $4 where id = $5 returning *`,
    [
      nextName,
      town !== undefined ? town : existing.town,
      facilityType || existing.facility_type,
      nextCanProvide,
      req.params.id,
    ]
  );
  res.json(camel(rows[0]));
});

// PATCH /api/facilities/:id/active
router.patch('/:id/active', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureFacilityCodeSchema();
  const { active } = req.body;
  const { rows } = await pool.query(
    'update facilities set active = $1 where id = $2 returning *',
    [!!active, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Facility not found.' });
  res.json(camel(rows[0]));
});

// PATCH /api/facilities/:id/can-provide-rounds — Super Admin only.
// When false, Facility Admins at this facility cannot create ILC rounds (they only participate).
router.patch('/:id/can-provide-rounds', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureFacilityCodeSchema();
  const { canProvideRounds } = req.body;
  const { rows } = await pool.query(
    'update facilities set can_provide_rounds = $1 where id = $2 returning *',
    [!!canProvideRounds, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Facility not found.' });
  res.json(camel(rows[0]));
});

// DELETE /api/facilities/:id — frees facility_code for reuse
router.delete('/:id', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureFacilityCodeSchema();
  const { rows: userRows } = await pool.query(
    'select count(*)::int as count from users where facility_id = $1',
    [req.params.id]
  );
  if (userRows[0].count > 0) {
    return res.status(409).json({
      error: `This facility still has ${userRows[0].count} user account(s). Remove or reassign them first.`,
    });
  }
  const { rows: roundRows } = await pool.query(
    'select count(*)::int as count from rounds where providing_facility_id = $1',
    [req.params.id]
  );
  if (roundRows[0].count > 0) {
    return res.status(409).json({
      error: `This facility still provides ${roundRows[0].count} round(s) of PT data. It cannot be deleted while that history exists.`,
    });
  }
  // Block if packages still owned by this facility
  try {
    const { rows: pkgRows } = await pool.query(
      'select count(*)::int as count from round_packages where providing_facility_id = $1',
      [req.params.id]
    );
    if (pkgRows[0] && pkgRows[0].count > 0) {
      return res.status(409).json({
        error: `This facility still has ${pkgRows[0].count} ILC package(s). Delete or reassign those rounds first.`,
      });
    }
  } catch (e) {
    // table may not exist on very old DBs — ignore
  }

  let rows;
  try {
    const result = await pool.query('delete from facilities where id = $1 returning id, facility_code', [
      req.params.id,
    ]);
    rows = result.rows;
  } catch (e) {
    if (e && e.code === '23503') {
      return res.status(409).json({
        error: 'This facility is still referenced by other records (users, rounds, or submissions). Remove those first.',
      });
    }
    console.error('Facility delete failed:', e.message);
    return res.status(500).json({ error: 'Could not delete facility. Check server logs and try again.' });
  }
  if (!rows[0]) return res.status(404).json({ error: 'Facility not found.' });
  res.json({ deleted: true, freedCode: rows[0].facility_code || null });
});



async function ensureRegistrationSchema() {
  await pool.query(`
    create table if not exists facility_registrations (
      id serial primary key,
      name text not null,
      town text,
      facility_type text not null default 'government',
      lab_email text not null,
      contact_name text,
      status text not null default 'pending',
      rejection_reason text,
      reviewed_by integer,
      reviewed_at timestamptz,
      created_facility_id integer references facilities(id) on delete set null,
      created_at timestamptz default now()
    );
  `);
  await pool.query(`
    create index if not exists idx_facility_registrations_status on facility_registrations(status);
  `);
  // Concurrent-safe uniqueness: same email cannot hold two pending/approved registrations.
  try {
    await pool.query(`
      create unique index if not exists facility_registrations_email_active_uidx
        on facility_registrations (lower(trim(lab_email)))
        where status in ('pending', 'approved');
    `);
  } catch (e) {
    console.warn('Could not create facility_registrations email unique index (existing duplicates?):', e.message);
  }
  // Exact normalized name uniqueness among pending/approved registrations
  try {
    await pool.query(`
      create unique index if not exists facility_registrations_name_active_uidx
        on facility_registrations (lower(trim(name)))
        where status in ('pending', 'approved');
    `);
  } catch (e) {
    console.warn('Could not create facility_registrations name unique index (existing duplicates?):', e.message);
  }
}

/** Lowercase, collapse punctuation/spaces for comparison. */
function normalizeFacilityName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ensureFacilityNameUniqueIndex() {
  try {
    await pool.query(`
      create unique index if not exists facilities_name_normalized_uidx
        on facilities (lower(trim(name)));
    `);
  } catch (e) {
    // Pre-existing duplicate names block the index — app-level checks still apply.
    console.warn('Could not create facilities name unique index (existing duplicates?):', e.message);
  }
}

/**
 * Facilities / pending registrations whose names contain the query (case-insensitive).
 * Progressive: longer query → fewer hits. Not a hard block by itself.
 */
async function searchFacilityNameMatches(query, limit = 12) {
  const q = normalizeFacilityName(query);
  if (q.length < 1) return [];
  const like = `%${q.replace(/\s+/g, '%')}%`;
  const prefix = `${q}%`;
  const { rows: facRows } = await pool.query(
    `select id, name, town, facility_code, facility_type, active, 'registered' as source
       from facilities
      where lower(trim(name)) like $1
         or lower(regexp_replace(name, '[^a-zA-Z0-9]+', ' ', 'g')) like $1
      order by
        case when lower(trim(name)) = $2 then 0
             when lower(trim(name)) like $3 then 1
             else 2 end,
        name
      limit $4`,
    [like, q, prefix, limit]
  );
  const { rows: regRows } = await pool.query(
    `select id, name, town, null as facility_code, facility_type, true as active, 'pending_registration' as source
       from facility_registrations
      where status = 'pending'
        and (lower(trim(name)) like $1
             or lower(regexp_replace(name, '[^a-zA-Z0-9]+', ' ', 'g')) like $1)
      order by name
      limit $2`,
    [like, limit]
  );
  // Prefer registered over pending; dedupe by normalized name
  const seen = new Set();
  const out = [];
  for (const r of [...facRows, ...regRows]) {
    const key = normalizeFacilityName(r.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      name: r.name,
      town: r.town || null,
      facilityCode: r.facility_code || null,
      facilityType: r.facility_type || null,
      active: r.active !== false,
      source: r.source,
      exact: key === q,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function findEmailConflict(labEmail) {
  const email = String(labEmail || '').trim().toLowerCase();
  if (!email) return null;
  const { rows: regRows } = await pool.query(
    `select id, name, status, lab_email
       from facility_registrations
      where lower(trim(lab_email)) = $1
        and status in ('pending', 'approved')
      limit 1`,
    [email]
  );
  if (regRows[0]) {
    return {
      kind: 'registration',
      status: regRows[0].status,
      name: regRows[0].name,
      message:
        'This email address is already associated with a registered facility. Please check the existing facility details or contact the administrator.',
    };
  }
  // Users already linked to a facility with this email
  const { rows: userRows } = await pool.query(
    `select u.id, u.name, u.facility_id, f.name as facility_name, f.facility_code
       from users u
       left join facilities f on f.id = u.facility_id
      where lower(trim(u.email)) = $1
        and u.facility_id is not null
      limit 1`,
    [email]
  );
  if (userRows[0]) {
    const code = userRows[0].facility_code ? ` (${userRows[0].facility_code})` : '';
    return {
      kind: 'user',
      name: userRows[0].facility_name || userRows[0].name,
      message:
        `This email address is already associated with a registered facility${code}. Please check the existing facility details or contact the administrator.`,
    };
  }
  return null;
}

function camelReg(r) {
  return {
    id: r.id,
    name: r.name,
    town: r.town,
    facilityType: r.facility_type,
    labEmail: r.lab_email,
    contactName: r.contact_name,
    status: r.status,
    rejectionReason: r.rejection_reason,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdFacilityId: r.created_facility_id,
    createdAt: r.created_at,
  };
}

// GET /api/facilities/name-search?q= — progressive public name lookup for subscribe form
router.get('/name-search', async (req, res) => {
  await ensureRegistrationSchema();
  await ensureFacilityCodeSchema();
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json({ matches: [] });
  try {
    const matches = await searchFacilityNameMatches(q, 12);
    res.json({ matches, query: q });
  } catch (e) {
    console.error('name-search failed:', e.message);
    res.status(500).json({ error: 'Could not search facilities.' });
  }
});

// POST /api/facilities/subscribe — public self-registration (pending until Super Admin approves)
// Duplicate protection: email uniqueness, exact name block, similar-name warning (client may
// re-submit with acknowledgeSimilar:true for non-exact matches only).
router.post('/subscribe', async (req, res) => {
  await ensureRegistrationSchema();
  await ensureFacilityCodeSchema();
  const name = (req.body.name || '').trim();
  const town = (req.body.town || '').trim() || null;
  const facilityType = req.body.facilityType === 'private' ? 'private' : 'government';
  const labEmail = (req.body.labEmail || '').trim();
  const contactName = (req.body.contactName || '').trim() || null;
  const acknowledgeSimilar = !!req.body.acknowledgeSimilar;

  if (!name) return res.status(400).json({ error: 'Facility name is required.' });
  if (!labEmail || !labEmail.includes('@')) {
    return res.status(400).json({ error: 'A valid laboratory email address is required.' });
  }

  // 1) Email — hard block
  const emailConflict = await findEmailConflict(labEmail);
  if (emailConflict) {
    return res.status(409).json({
      error: emailConflict.message,
      code: 'DUPLICATE_EMAIL',
      conflict: emailConflict,
    });
  }

  const normalized = normalizeFacilityName(name);

  // 2) Exact name on facilities — hard block
  const { rows: existingFac } = await pool.query(
    `select id, name, facility_code from facilities
      where lower(trim(name)) = lower(trim($1))
         or lower(regexp_replace(name, '[^a-zA-Z0-9]+', ' ', 'g')) = $2
      limit 1`,
    [name, normalized]
  );
  if (existingFac.length) {
    const d = existingFac[0];
    return res.status(409).json({
      error:
        `This facility appears to be already registered${d.facility_code ? ` (${d.facility_code})` : ''}: "${d.name}". ` +
        'Please do not create another registration for the same facility. Contact the administrator if the existing record requires correction or updating.',
      code: 'DUPLICATE_NAME_EXACT',
      matches: [{ id: d.id, name: d.name, facilityCode: d.facility_code, source: 'registered', exact: true }],
    });
  }

  // 3) Exact pending registration name — hard block
  const { rows: pendingExact } = await pool.query(
    `select id, name, lab_email, status from facility_registrations
      where status = 'pending'
        and (lower(trim(name)) = lower(trim($1))
             or lower(regexp_replace(name, '[^a-zA-Z0-9]+', ' ', 'g')) = $2)
      limit 1`,
    [name, normalized]
  );
  if (pendingExact.length) {
    return res.status(409).json({
      error:
        'A registration for this laboratory name is already pending review. Please wait for the administrator to respond.',
      code: 'DUPLICATE_NAME_PENDING',
    });
  }

  // 4) Similar names — soft warn unless acknowledged
  const similar = await searchFacilityNameMatches(name, 8);
  const similarNonExact = similar.filter((m) => !m.exact);
  if (similarNonExact.length && !acknowledgeSimilar) {
    return res.status(409).json({
      error: 'A facility with a similar name is already registered.',
      code: 'SIMILAR_NAME',
      matches: similarNonExact,
      message:
        'A facility with a similar name is already registered. Review the list below. If this is not your facility, you may continue registration.',
    });
  }

  try {
    const { rows } = await pool.query(
      `insert into facility_registrations (name, town, facility_type, lab_email, contact_name, status)
       values ($1, $2, $3, $4, $5, 'pending') returning *`,
      [name, town, facilityType, labEmail, contactName]
    );
    res.status(201).json({
      message:
        'Registration received. A Super Admin will review it. You will be contacted using the laboratory email provided.',
      registration: camelReg(rows[0]),
    });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({
        error:
          'This registration conflicts with an existing facility or pending request (same email or name). Contact the administrator if you need help.',
        code: 'UNIQUE_VIOLATION',
      });
    }
    console.error('subscribe failed:', e);
    res.status(500).json({ error: 'Could not submit registration. Please try again.' });
  }
});

// GET /api/facilities/registrations — Super Admin pending/processed list
router.get('/registrations', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureRegistrationSchema();
  const status = (req.query.status || 'pending').trim();
  const { rows } = await pool.query(
    `select * from facility_registrations
      where ($1 = 'all' or status = $1)
      order by created_at desc`,
    [status]
  );
  res.json(rows.map(camelReg));
});

// POST /api/facilities/registrations/:id/approve — create facility, mark approved
router.post('/registrations/:id/approve', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureRegistrationSchema();
  await ensureFacilityCodeSchema();
  const { rows: regRows } = await pool.query('select * from facility_registrations where id = $1', [req.params.id]);
  const reg = regRows[0];
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  if (reg.status !== 'pending') {
    return res.status(400).json({ error: `This registration is already ${reg.status}.` });
  }

  const { rows: existingFac } = await pool.query(
    `select id, name from facilities where lower(trim(name)) = lower(trim($1)) limit 1`,
    [reg.name]
  );
  if (existingFac.length) {
    return res.status(409).json({
      error: `Cannot approve: a facility named "${existingFac[0].name}" already exists. Reject this request or rename the existing facility first.`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const code = await allocateFacilityCode(client);
    const { rows: facRows } = await client.query(
      `insert into facilities (name, town, facility_type, facility_code, active)
       values ($1, $2, $3, $4, true) returning *`,
      [reg.name, reg.town, reg.facility_type, code]
    );
    const fac = facRows[0];
    await client.query(
      `update facility_registrations
          set status = 'approved', reviewed_by = $1, reviewed_at = now(), created_facility_id = $2
        where id = $3`,
      [req.user.id, fac.id, reg.id]
    );
    await client.query('commit');
    res.json({
      message: `Approved. Facility created as ${code}.`,
      facility: camel(fac),
    });
  } catch (e) {
    await client.query('rollback');
    console.error(e);
    res.status(500).json({ error: 'Could not approve registration.' });
  } finally {
    client.release();
  }
});

// POST /api/facilities/registrations/:id/reject
router.post('/registrations/:id/reject', requireAuth, requireRole('superadmin'), async (req, res) => {
  await ensureRegistrationSchema();
  const reason = (req.body.reason || '').trim() || null;
  const { rows } = await pool.query(
    `update facility_registrations
        set status = 'rejected', rejection_reason = $1, reviewed_by = $2, reviewed_at = now()
      where id = $3 and status = 'pending'
      returning *`,
    [reason, req.user.id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pending registration not found.' });
  res.json({ message: 'Registration rejected.', registration: camelReg(rows[0]) });
});

module.exports = router;
