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

  const client = await pool.connect();
  try {
    await client.query('begin');
    const code = await allocateFacilityCode(client);
    const { rows } = await client.query(
      `insert into facilities (name, town, facility_type, facility_code)
       values ($1, $2, $3, $4) returning *`,
      [name.trim(), town || null, facilityType || 'government', code]
    );
    await client.query('commit');
    res.status(201).json(camel(rows[0]));
  } catch (e) {
    await client.query('rollback');
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Facility code conflict — try again.' });
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
  const { rows } = await pool.query(
    `update facilities set name = $1, town = $2, facility_type = $3 where id = $4 returning *`,
    [
      name || existing.name,
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

module.exports = router;
