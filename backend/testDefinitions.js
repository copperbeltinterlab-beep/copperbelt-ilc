// Mirrors the frontend's TESTS/FBC_ANALYTES/CHEM_ANALYTES definitions, just enough for
// the consensus engine to know each test's kind and field keys. If you add/change a test
// or analyte on the frontend, mirror the change here too.

const TESTS = {
  bloodgroup: { kind: 'qualitative', fields: ['abo', 'rhesus', 'saline', 'ahg'] },
  hiv: { kind: 'qualitative', fields: ['value'] },
  hbsag: { kind: 'qualitative', fields: ['value'] },
  rpr: { kind: 'qualitative', fields: ['value'] },
  pregnancy: { kind: 'qualitative', fields: ['value'] },
  fbc: { kind: 'quantitative', fields: ['wbc', 'rbc', 'hgb', 'hct', 'plt'] },
  chem: { kind: 'quantitative', fields: ['glucose', 'urea', 'creatinine', 'sodium', 'potassium'] },
};

function getTestDef(testId) {
  return TESTS[testId] || null;
}

module.exports = { getTestDef };
