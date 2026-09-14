const { getTestDef } = require('./testDefinitions');

const MIN_PARTICIPANTS = 3; // minimum facilities needed for a statistically meaningful consensus
const SDI_LIMIT = 2; // |SDI| <= 2 is Acceptable, matching common EQA practice

// Reads a field's value tolerantly — supports the { value, notPerformed } shape and
// older flat values from before the per-analyte redesign.
function readField(result, key) {
  const v = result ? result[key] : undefined;
  if (v && typeof v === 'object' && ('value' in v || 'notPerformed' in v)) {
    return { value: v.value, notPerformed: !!v.notPerformed };
  }
  return { value: v ?? null, notPerformed: false };
}

function computeQualitativeField(entries) {
  const counts = {};
  entries.forEach(e => { counts[e.value] = (counts[e.value] || 0) + 1; });
  const n = entries.length;
  if (n < MIN_PARTICIPANTS) {
    return { n, insufficientData: true, consensusValue: null, tie: false, percentAgreement: null, counts };
  }
  const maxCount = Math.max(...Object.values(counts));
  const modes = Object.keys(counts).filter(k => counts[k] === maxCount);
  const tie = modes.length > 1;
  return {
    n, insufficientData: false, tie,
    consensusValue: tie ? null : modes[0],
    percentAgreement: tie ? null : Math.round((maxCount / n) * 100),
    counts,
  };
}

function medianOf(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * ISO 13528 Algorithm A (robust mean and robust SD).
 * One extreme laboratory value is down-weighted so it cannot dominate the consensus.
 * Returns { mean, sd } (robust estimates; property names kept for existing callers).
 */
function robustAlgorithmA(values) {
  const n = values.length;
  if (n === 0) return { mean: null, sd: null };

  const sorted = values.slice().sort((a, b) => a - b);
  let xStar = medianOf(sorted);

  // Initial scale: MAD * 1.483 (consistent for normal data); floor avoids zero SD
  const absDev = values.map(v => Math.abs(v - xStar)).sort((a, b) => a - b);
  let sStar = 1.483 * medianOf(absDev);
  if (!sStar || sStar < 1e-12) {
    // All values essentially equal — use classical SD or a tiny epsilon
    const classicalMean = values.reduce((s, v) => s + v, 0) / n;
    const classicalVar = n > 1
      ? values.reduce((s, v) => s + Math.pow(v - classicalMean, 2), 0) / (n - 1)
      : 0;
    sStar = Math.sqrt(classicalVar);
    if (sStar < 1e-12) sStar = 0;
    return { mean: xStar, sd: sStar };
  }

  // Iterate until robust mean/SD stabilise (ISO 13528 Algorithm A)
  const maxIter = 50;
  for (let iter = 0; iter < maxIter; iter++) {
    const delta = 1.5 * sStar;
    const winsorized = values.map(v => {
      if (v < xStar - delta) return xStar - delta;
      if (v > xStar + delta) return xStar + delta;
      return v;
    });
    const newMean = winsorized.reduce((s, v) => s + v, 0) / n;
    const sumSq = winsorized.reduce((s, v) => s + Math.pow(v - newMean, 2), 0);
    // ISO 13528 uses 1.134 as the consistency factor for the winsorized SD estimator
    const newSd = n > 1 ? 1.134 * Math.sqrt(sumSq / (n - 1)) : 0;

    const meanDiff = Math.abs(newMean - xStar);
    const sdDiff = Math.abs(newSd - sStar);
    xStar = newMean;
    sStar = newSd;
    if (meanDiff < 1e-9 * (1 + Math.abs(xStar)) && sdDiff < 1e-9 * (1 + sStar)) break;
  }

  return { mean: xStar, sd: sStar };
}

function computeQuantitativeField(entries) {
  const n = entries.length;
  if (n < MIN_PARTICIPANTS) {
    return {
      n,
      insufficientData: true,
      mean: null,
      sd: null,
      method: 'robust_algorithm_a',
    };
  }
  const values = entries.map(e => e.value);
  const { mean, sd } = robustAlgorithmA(values);

  // Also expose classical mean/SD for transparency in admin reports (not used for scoring)
  const classicalMean = values.reduce((s, v) => s + v, 0) / n;
  const classicalVar = n > 1
    ? values.reduce((s, v) => s + Math.pow(v - classicalMean, 2), 0) / (n - 1)
    : 0;
  const classicalSd = Math.sqrt(classicalVar);

  return {
    n,
    insufficientData: false,
    mean, // robust consensus location (Algorithm A)
    sd,   // robust consensus scale (Algorithm A)
    method: 'robust_algorithm_a',
    classicalMean,
    classicalSd,
  };
}

function evaluateQualitative(value, notPerformed, fieldStats) {
  if (notPerformed) return { status: 'not_performed' };
  if (value === null || value === undefined || value === '') return { status: 'not_performed' };
  if (fieldStats.insufficientData) return { status: 'not_evaluated', reason: 'Insufficient participants for consensus.' };
  if (fieldStats.tie) return { status: 'not_evaluated', reason: 'No clear consensus (tie between values).' };
  return { status: value === fieldStats.consensusValue ? 'acceptable' : 'unacceptable' };
}

function evaluateQuantitative(value, notPerformed, fieldStats) {
  if (notPerformed) return { status: 'not_performed' };
  if (value === null || value === undefined || value === '' || isNaN(Number(value))) {
    return { status: 'not_performed' };
  }
  if (fieldStats.insufficientData) {
    return { status: 'not_evaluated', reason: 'Insufficient participants for consensus.', sdi: null };
  }
  const num = Number(value);
  const mean = fieldStats.mean;
  const sd = fieldStats.sd;
  if (sd === 0 || sd === null || sd === undefined) {
    // All participants identical (or zero robust scale): exact match only
    const match = Math.abs(num - mean) < 1e-9;
    return { status: match ? 'acceptable' : 'unacceptable', sdi: match ? 0 : Infinity };
  }
  const sdi = (num - mean) / sd;
  const status = Math.abs(sdi) <= SDI_LIMIT ? 'acceptable' : 'unacceptable';
  return { status, sdi };
}

function overallStatus(fieldEvals) {
  const statuses = Object.values(fieldEvals).map(f => f.status);
  if (statuses.length === 0) return 'not_evaluated';
  if (statuses.every(s => s === 'not_performed')) return 'not_performed';
  if (statuses.some(s => s === 'unacceptable')) return 'unacceptable';
  if (statuses.some(s => s === 'not_evaluated')) return 'not_evaluated';
  if (statuses.every(s => s === 'acceptable' || s === 'not_performed')) return 'acceptable';
  return 'not_evaluated';
}

// Optional human labels for comment lines (keys only if no richer label map is available)
function fieldLabel(testId, key) {
  return key;
}

function buildConsensusReport(testId, submissions) {
  const def = getTestDef(testId);
  if (!def) return { error: `Unknown test: ${testId}` };

  // Only non-rejected submissions with results contribute to consensus
  const reportable = submissions.filter(s => s.sampleAcceptability !== 'rejected');

  const fieldStats = {};
  def.fields.forEach(key => {
    const entries = [];
    reportable.forEach(s => {
      const { value, notPerformed } = readField(s.result, key);
      if (!notPerformed && value !== null && value !== undefined && value !== '') {
        if (def.kind === 'quantitative') {
          const num = Number(value);
          if (!isNaN(num)) entries.push({ facilityId: s.facilityId, value: num });
        } else {
          entries.push({ facilityId: s.facilityId, value: String(value) });
        }
      }
    });
    fieldStats[key] = def.kind === 'quantitative'
      ? computeQuantitativeField(entries)
      : computeQualitativeField(entries);
  });

  const perSubmission = submissions.map(s => {
    if (s.sampleAcceptability === 'rejected') {
      return {
        submissionId: s.id,
        facilityId: s.facilityId,
        overall: 'not_evaluated',
        fields: {},
        comment: 'Sample rejected on receipt — no results expected.',
      };
    }
    const fieldEvals = {};
    const commentLines = [];
    def.fields.forEach(key => {
      const { value, notPerformed } = readField(s.result, key);
      const stats = fieldStats[key];
      const evalResult = def.kind === 'quantitative'
        ? evaluateQuantitative(value, notPerformed, stats)
        : evaluateQualitative(value, notPerformed, stats);
      fieldEvals[key] = evalResult;

      const label = fieldLabel(testId, key);
      if (evalResult.status === 'not_performed') {
        commentLines.push(`${label}: Test Not Performed`);
      } else if (def.kind === 'quantitative') {
        const sdiText = evalResult.sdi === undefined || evalResult.sdi === null
          ? ''
          : ` (SDI ${evalResult.sdi === Infinity ? '∞' : evalResult.sdi.toFixed(2)})`;
        const meanText = stats.insufficientData
          ? 'insufficient data'
          : `robust mean ${Number(stats.mean).toFixed(2)} ± ${Number(stats.sd).toFixed(2)} (Alg. A, n=${stats.n})`;
        commentLines.push(`${label}: ${value} — ${meanText}${sdiText} → ${evalResult.status}`);
      } else {
        const consensusText = stats.insufficientData
          ? 'insufficient data'
          : stats.tie
            ? 'no clear consensus'
            : `consensus ${stats.consensusValue} (${stats.percentAgreement}% agreement, n=${stats.n})`;
        commentLines.push(`${label}: ${value} — ${consensusText} → ${evalResult.status}`);
      }
    });
    return {
      submissionId: s.id,
      facilityId: s.facilityId,
      overall: overallStatus(fieldEvals),
      fields: fieldEvals,
      comment: commentLines.join('\n'),
    };
  });

  return { fieldStats, perSubmission };
}

module.exports = {
  buildConsensusReport,
  readField,
  robustAlgorithmA,
  computeQuantitativeField,
  SDI_LIMIT,
  MIN_PARTICIPANTS,
};
