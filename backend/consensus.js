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

function computeQuantitativeField(entries) {
  const n = entries.length;
  if (n < MIN_PARTICIPANTS) {
    return { n, insufficientData: true, mean: null, sd: null };
  }
  const mean = entries.reduce((sum, e) => sum + e.value, 0) / n;
  const variance = entries.reduce((sum, e) => sum + Math.pow(e.value - mean, 2), 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return { n, insufficientData: false, mean, sd };
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
  if (value === null || value === undefined || value === '' || isNaN(Number(value))) return { status: 'not_performed' };
  if (fieldStats.insufficientData) return { status: 'not_evaluated', reason: 'Insufficient participants for consensus.' };
  const numValue = Number(value);
  let sdi;
  if (fieldStats.sd === 0) {
    sdi = numValue === fieldStats.mean ? 0 : Infinity;
  } else {
    sdi = (numValue - fieldStats.mean) / fieldStats.sd;
  }
  return { status: Math.abs(sdi) <= SDI_LIMIT ? 'acceptable' : 'unacceptable', sdi };
}

function overallStatus(fieldEvals) {
  const statuses = Object.values(fieldEvals).map(f => f.status);
  if (statuses.length === 0) return 'not_evaluated';
  if (statuses.every(s => s === 'not_performed')) return 'not_evaluated';
  if (statuses.includes('unacceptable')) return 'unacceptable';
  if (statuses.includes('not_evaluated')) return 'not_evaluated';
  return 'acceptable';
}

function fieldLabel(testId, key) {
  return key.toUpperCase();
}

function buildConsensusReport(testId, submissions) {
  const def = getTestDef(testId);
  if (!def) return { error: `Unknown test definition for "${testId}".` };

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
    fieldStats[key] = def.kind === 'quantitative' ? computeQuantitativeField(entries) : computeQualitativeField(entries);
  });

  const perSubmission = submissions.map(s => {
    if (s.sampleAcceptability === 'rejected') {
      return { submissionId: s.id, facilityId: s.facilityId, overall: 'not_evaluated', fields: {}, comment: 'Sample rejected on receipt — no results expected.' };
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
        const sdiText = evalResult.sdi === undefined ? '' : ` (SDI ${evalResult.sdi === Infinity ? '∞' : evalResult.sdi.toFixed(2)})`;
        const meanText = stats.insufficientData ? 'insufficient data' : `group mean ${stats.mean.toFixed(2)} ± ${stats.sd.toFixed(2)}`;
        commentLines.push(`${label}: ${value} — ${meanText}${sdiText} → ${evalResult.status}`);
      } else {
        const consensusText = stats.insufficientData ? 'insufficient data'
          : stats.tie ? 'no clear consensus' : `consensus ${stats.consensusValue} (${stats.percentAgreement}% agreement, n=${stats.n})`;
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

module.exports = { buildConsensusReport, readField };
