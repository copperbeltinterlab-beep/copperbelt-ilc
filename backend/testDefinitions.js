// Mirrors the frontend's TESTS definitions, just enough for the consensus engine to know
// each test's kind and field keys. If you add/change a test or analyte on the frontend,
// mirror the change here too.
//
// Field keys and units below come from the supplied Test Profiles source document —
// codes/terminology are preserved as given, not invented. Chemistry field keys match the
// document's official codes (glu2, ure1, cre1, na, k, ...) rather than the old ad-hoc names.

const TESTS = {
  bloodgroup: { name: 'Blood Grouping and Cross Match', kind: 'qualitative', fields: ['abo', 'rhesus', 'saline', 'ahg'] },
  hiv: { name: 'HIV Serology', kind: 'qualitative', fields: ['value'] },
  hbsag: { name: 'HBsAg Serology', kind: 'qualitative', fields: ['value'] },
  rpr: { name: 'RPR Serology', kind: 'qualitative', fields: ['value'] },
  pregnancy: { name: 'Pregnancy Test', kind: 'qualitative', fields: ['value'] },
  mtbrif: { name: 'MTB Rif (GeneXpert)', kind: 'qualitative', fields: ['mtb', 'rif', 'riflevel'] },

  fbc: {
    name: 'Full Blood Count',
    kind: 'quantitative',
    fields: [
      'wbc', 'rbc', 'hgb', 'hct', 'plt',
      'mcv', 'mch', 'mchc', 'rdw', 'pdw',
      'neut', 'lymph', 'mono', 'eos', 'baso',
    ],
  },
  chem: {
    name: 'Chemistry',
    kind: 'quantitative',
    fields: [
      'amyl2', 'ch021', 'alb2', 'ure1', 'blt3', 'bld2', 'trgl', 'glu2', 'tp2m', 'ua2',
      'cre1', 'alt1', 'astl', 'alp', 'na', 'k', 'cl', 'hco3', 'ca', 'po4', 'mg',
      'ggt', 'ldh', 'ck', 'iron', 'ferritin',
    ],
  },
  cd4: { name: 'CD4', kind: 'quantitative', fields: ['cd4'] },
};

// The four permitted "Test Not Performed" reasons — identical set on frontend and backend.
// Free text is never accepted in place of one of these.
const NOT_PERFORMED_REASONS = [
  'Reagent Out Stock',
  'Analyser Out of Service (Maintenance and Calibration)',
  'Analyser Breakdown',
  'Test not Available',
];

function getTestDef(testId) {
  return TESTS[testId] || null;
}

// Human-readable test name, used to build round labels for email notifications.
function getTestName(testId) {
  return (TESTS[testId] && TESTS[testId].name) || testId;
}

module.exports = { getTestDef, getTestName, NOT_PERFORMED_REASONS };
