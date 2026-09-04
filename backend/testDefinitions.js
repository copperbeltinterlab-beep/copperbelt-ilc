// Mirrors the frontend's TESTS/FBC_ANALYTES/CHEM_ANALYTES definitions, just enough for
// the consensus engine to know each test's kind and field keys. If you add/change a test
// or analyte on the frontend, mirror the change here too.

const TESTS = {
  bloodgroup: { name: 'Blood Grouping and Cross Match', kind: 'qualitative', fields: ['abo', 'rhesus', 'saline', 'ahg'] },
  hiv: { name: 'HIV Serology', kind: 'qualitative', fields: ['value'] },
  hbsag: { name: 'HBsAg Serology', kind: 'qualitative', fields: ['value'] },
  rpr: { name: 'RPR Serology', kind: 'qualitative', fields: ['value'] },
  pregnancy: { name: 'Pregnancy Test', kind: 'qualitative', fields: ['value'] },
  fbc: { name: 'Full Blood Count', kind: 'quantitative', fields: ['wbc', 'rbc', 'hgb', 'hct', 'plt'] },
  chem: { name: 'Chemistry', kind: 'quantitative', fields: ['glucose', 'urea', 'creatinine', 'sodium', 'potassium'] },
};

function getTestDef(testId) {
  return TESTS[testId] || null;
}

// Human-readable test name, used to build round labels for email notifications.
function getTestName(testId) {
  return (TESTS[testId] && TESTS[testId].name) || testId;
}

module.exports = { getTestDef, getTestName };
