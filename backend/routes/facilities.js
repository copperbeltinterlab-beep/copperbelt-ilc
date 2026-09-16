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
  };
}

async function ensureFacilityCodeSchema() {
  await pool.query(`
    alter table facilities add column if not exists facility_code text;
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
  const { name, town, facilityType } = req.body;
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

  const { rows } = await pool.query(
    `update facilities set name = $1, town = $2, facility_type = $3 where id = $4 returning *`,
    [
      nextName,
      town !== undefined ? town : existing.town,
      facilityType || existing.facility_type,
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
  const { rows } = await pool.query('delete from facilities where id = $1 returning id, facility_code', [
    req.params.id,
  ]);
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

// POST /api/facilities/subscribe — public self-registration (pending until Super Admin approves)
router.post('/subscribe', async (req, res) => {
  await ensureRegistrationSchema();
  await ensureFacilityCodeSchema();
  const name = (req.body.name || '').trim();
  const town = (req.body.town || '').trim() || null;
  const facilityType = req.body.facilityType === 'private' ? 'private' : 'government';
  const labEmail = (req.body.labEmail || '').trim();
  const contactName = (req.body.contactName || '').trim() || null;

  if (!name) return res.status(400).json({ error: 'Facility name is required.' });
  if (!labEmail || !labEmail.includes('@')) {
    return res.status(400).json({ error: 'A valid laboratory email address is required.' });
  }

  const { rows: existingFac } = await pool.query(
    `select id, name, facility_code from facilities where lower(trim(name)) = lower(trim($1)) limit 1`,
    [name]
  );
  if (existingFac.length) {
    const d = existingFac[0];
    return res.status(409).json({
      error: `This laboratory is already registered${d.facility_code ? ` (${d.facility_code})` : ''}: "${d.name}". Contact the programme administrator if you need access.`,
    });
  }

  const { rows: pending } = await pool.query(
    `select id from facility_registrations
      where status = 'pending' and lower(trim(name)) = lower(trim($1))
      limit 1`,
    [name]
  );
  if (pending.length) {
    return res.status(409).json({
      error: 'A registration for this laboratory name is already pending review. Please wait for the administrator to respond.',
    });
  }

  const { rows } = await pool.query(
    `insert into facility_registrations (name, town, facility_type, lab_email, contact_name, status)
     values ($1, $2, $3, $4, $5, 'pending') returning *`,
    [name, town, facilityType, labEmail, contactName]
  );
  res.status(201).json({
    message: 'Registration received. A Super Admin will review it. You will be contacted using the laboratory email provided.',
    registration: camelReg(rows[0]),
  });
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
