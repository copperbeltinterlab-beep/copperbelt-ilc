const { getTestDef } = require('./testDefinitions');

const MIN_PARTICIPANTS = 3; // minimum facilities needed for a statistically meaningful consensus
const SDI_LIMIT = 2; // |SDI| <= 2 is Acceptable against the cleaned mean/SD
const OUTLIER_Z_LIMIT = 3; // | (x − median) / (1.483×MAD) | > 3 → exclude from consensus
const MIN_AFTER_EXCLUSION = 2; // need at least this many values after exclusion

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

function classicalMeanSd(values) {
  const n = values.length;
  if (n === 0) return { mean: null, sd: null };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { mean, sd: 0 };
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (n - 1);
  return { mean, sd: Math.sqrt(variance) };
}

/**
 * Exclude gross outliers using a robust scale, then classical mean/SD on the rest.
 *
 * Why not classical SDI for exclusion?
 * With few labs, one wild value inflates SD so much that its own |SDI| stays < 3
 * and is never removed — producing wide / negative “acceptable” bands.
 *
 * Detection (robust): median + MAD×1.483. Drop |z| > OUTLIER_Z_LIMIT.
 * Consensus (classical): mean and sample SD of remaining values only.
 * Scoring: every lab (including excluded) is scored with SDI vs cleaned mean/SD,
 * acceptable if |SDI| ≤ SDI_LIMIT (2).
 */
function meanSdAfterOutlierExclusion(values) {
  const n = values.length;
  if (n === 0) {
    return {
      mean: null, sd: null, nUsed: 0, nExcluded: 0, excludedValues: [],
    };
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const med = medianOf(sorted);
  const absDev = values.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  let madScale = 1.483 * medianOf(absDev);

  let kept = values.slice();
  let excludedValues = [];

  if (n >= MIN_PARTICIPANTS) {
    if (!madScale || madScale < 1e-12) {
      // All values essentially identical — nothing to exclude
      madScale = 0;
    } else {
      const candidates = [];
      const outliers = [];
      values.forEach(v => {
        const z = Math.abs((v - med) / madScale);
        if (z > OUTLIER_Z_LIMIT) outliers.push(v);
        else candidates.push(v);
      });
      if (outliers.length > 0 && candidates.length >= MIN_AFTER_EXCLUSION) {
        kept = candidates;
        excludedValues = outliers;
      }
    }
  }

  // Small-n safety: Dixon-style gap test when MAD fails to flag but one point is isolated
  // (e.g. 28, 30, 95 with tiny MAD between 28 and 30 making 95 extreme).
  if (excludedValues.length === 0 && n === 3) {
    const s = sorted;
    const range = s[2] - s[0];
    if (range > 1e-12) {
      const qLow = (s[1] - s[0]) / range;
      const qHigh = (s[2] - s[1]) / range;
      // Critical Q for n=3 at ~95% is ≈ 0.941
      if (qHigh >= 0.941 && qHigh >= qLow) {
        excludedValues = [s[2]];
        kept = values.filter(v => v !== s[2]);
        // if duplicate of s[2] exists, only remove one extreme instance via index
        if (kept.length < MIN_AFTER_EXCLUSION) {
          kept = [s[0], s[1]];
          excludedValues = [s[2]];
        }
      } else if (qLow >= 0.941 && qLow > qHigh) {
        kept = [s[1], s[2]];
        excludedValues = [s[0]];
      }
    }
  }

  if (kept.length < MIN_AFTER_EXCLUSION) {
    kept = values.slice();
    excludedValues = [];
  }

  const final = classicalMeanSd(kept);
  return {
    mean: final.mean,
    sd: final.sd,
    nUsed: kept.length,
    nExcluded: excludedValues.length,
    excludedValues,
    detectionMedian: med,
    detectionScale: madScale,
  };
}

function computeQuantitativeField(entries) {
  const n = entries.length;
  if (n < MIN_PARTICIPANTS) {
    return {
      n,
      insufficientData: true,
      mean: null,
      sd: null,
      method: 'outlier_exclusion_mean_sd',
      nUsed: 0,
      nExcluded: 0,
    };
  }

  const values = entries.map(e => e.value);
  const result = meanSdAfterOutlierExclusion(values);

  return {
    n,
    insufficientData: false,
    mean: result.mean,
    sd: result.sd,
    method: 'outlier_exclusion_mean_sd',
    nUsed: result.nUsed,
    nExcluded: result.nExcluded,
    excludedValues: result.excludedValues,
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

function fieldLabel(testId, key) {
  return key;
}

function buildConsensusReport(testId, submissions) {
  const def = getTestDef(testId);
  if (!def) return { error: `Unknown test: ${testId}` };

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
        let meanText = 'insufficient data';
        if (!stats.insufficientData) {
          const excl = stats.nExcluded > 0 ? `, ${stats.nExcluded} outlier(s) excluded from mean` : '';
          meanText = `mean ${Number(stats.mean).toFixed(2)} ± ${Number(stats.sd).toFixed(2)} (n=${stats.nUsed}${excl})`;
        }
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
  meanSdAfterOutlierExclusion,
  computeQuantitativeField,
  SDI_LIMIT,
  OUTLIER_Z_LIMIT,
  MIN_PARTICIPANTS,
};
