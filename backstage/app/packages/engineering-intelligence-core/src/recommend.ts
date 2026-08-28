import { DimensionId, DimensionScore, Recommendation } from './model';
import { DIMENSIONS } from './dimensions';

// Recommendations are derived deterministically from evidence: a signal whose
// normalised score falls below its declared threshold produces one, carrying the
// evidence row that triggered it.
//
// No language model is involved. The AI Advisor (phase 9) reads these structured
// recommendations rather than generating its own from raw metrics, which is what
// keeps it from asserting conclusions the data does not support.

const SEVERITY_RANK: Record<Recommendation['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function recommend(
  dimensions: Record<DimensionId, DimensionScore>,
): Recommendation[] {
  const out: Recommendation[] = [];

  for (const config of DIMENSIONS) {
    const scored = dimensions[config.id];
    if (!scored) continue;
    // Note the deliberate absence of a status check here. A dimension whose
    // score was withheld has still had some of its signals measured, and those
    // measurements stay actionable — "we cannot summarise this dimension" is not
    // "we observed nothing in it". Suppressing them would lose real findings to
    // a rule about aggregation.

    for (const signal of config.signals) {
      if (signal.recommendBelow === undefined || !signal.recommendation)
        continue;

      const row = scored.evidence.find(e => e.metric === signal.metric);
      // No evidence means the signal was never measured. A missing measurement
      // is a data gap, not a finding — recommending action on it would be
      // asserting something about the organisation from an absence.
      if (!row) continue;
      if (row.normalised >= signal.recommendBelow) continue;

      out.push({
        id: `${config.id}.${signal.metric}`,
        dimension: config.id,
        severity: signal.recommendation.severity,
        title: `${signal.label} is below target`,
        action: signal.recommendation.action,
        evidence: [row],
      });
    }
  }

  // Most severe first, then furthest below its threshold — so the ranking
  // reflects how far off the mark a signal is, not the order dimensions are
  // declared in.
  return out.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.evidence[0].normalised - b.evidence[0].normalised;
  });
}

/**
 * Dimensions that could not be scored, phrased as work to do rather than as a
 * finding about the organisation. Kept separate from `recommend()` because
 * "we cannot measure this" and "this is bad" must never be presented alike.
 */
export function evidenceGaps(
  dimensions: Record<DimensionId, DimensionScore>,
): { dimension: DimensionId; missing: string[]; expectedFrom: string[] }[] {
  return DIMENSIONS.filter(
    c => dimensions[c.id]?.status === 'insufficient-evidence',
  ).map(c => ({
    dimension: c.id,
    missing: dimensions[c.id].missing.map(m => m.metric),
    expectedFrom: Array.from(
      new Set(dimensions[c.id].missing.map(m => m.expectedFrom)),
    ),
  }));
}
