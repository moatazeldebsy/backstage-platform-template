// The Engineering Intelligence data model.
//
// Deliberately free of any Backstage import. The scoring engine is consumed by
// the `engineering-intelligence` backend plugin today and will be consumed by
// the dashboard (phase 3) and the AI Advisor (phase 9) tomorrow; keeping it
// framework-free is what stops the scoring rules from being re-implemented per
// consumer. That has already happened once in this repo — the Bronze/Silver/Gold
// tier logic exists in three places with three different thresholds (see
// docs/engineering-intelligence/scoring.md#why-a-separate-package).

/** The seven dimensions of the Engineering Health model. */
export type DimensionId =
  | 'platform'
  | 'devEx'
  | 'quality'
  | 'reliability'
  | 'aiEngineering'
  | 'security'
  | 'finops';

export const DIMENSION_IDS: DimensionId[] = [
  'platform',
  'devEx',
  'quality',
  'reliability',
  'aiEngineering',
  'security',
  'finops',
];

/**
 * Whether a score can be trusted.
 *
 * - `ok`                     every signal in the dimension produced a sample
 * - `partial`                some signals are missing, but enough to score
 * - `insufficient-evidence`  too little data; `score` is null, never a number
 *
 * There is no fourth state where a number is invented. Every dashboard page in
 * `extensions.tsx` falls back to plausible demo data when its source is
 * unreachable; this model deliberately does not, because an Engineering Health
 * score is the kind of number that ends up on a slide.
 */
export type Status = 'ok' | 'partial' | 'insufficient-evidence';

/** One observation, as collected. Raw units — normalisation happens in scoring. */
export interface MetricSample {
  /** Stable identifier, e.g. `dora.leadTimeMinutes`. */
  metric: string;
  value: number;
  /** Where it came from, named concretely: `prometheus`, `opencost`, `catalog`. */
  source: string;
  /** ISO-8601. When the underlying source observed it, not when we read it. */
  observedAt: string;
  /** Optional dimension of the sample, e.g. `{ team: 'payments' }`. */
  labels?: Record<string, string>;
}

/**
 * Why a dimension scored what it scored. One row per contributing signal.
 *
 * `impact` is the signal's weighted contribution to the dimension score, so the
 * impacts of a dimension's evidence sum to that dimension's score. This is the
 * property that makes a score explainable rather than asserted, and it is
 * asserted directly in score.test.ts.
 */
export interface Evidence {
  metric: string;
  /** Raw observed value, in the metric's own units. */
  value: number;
  /** The 0–100 value after normalisation. */
  normalised: number;
  source: string;
  observedAt: string;
  /** Weighted contribution to the dimension score. */
  impact: number;
  /**
   * Set when the signal measures something narrower than its name suggests.
   * Used by the security signals, which observe whether a scanning control is
   * declared — not whether it found anything.
   */
  caveat?: string;
}

/** A signal that was expected but had no sample. */
export interface MissingSignal {
  metric: string;
  /** The source that would have provided it, so the gap is actionable. */
  expectedFrom: string;
  reason: string;
}

export interface DimensionScore {
  dimension: DimensionId;
  /** 0–100, or null when `status` is `insufficient-evidence`. */
  score: number | null;
  status: Status;
  /** Fraction of the dimension's total signal weight that produced a sample. */
  coverage: number;
  evidence: Evidence[];
  missing: MissingSignal[];
}

export interface Recommendation {
  id: string;
  dimension: DimensionId;
  /** `critical` maps to 🔴, `warning` to 🟠 in the phase-3 dashboard. */
  severity: 'critical' | 'warning' | 'info';
  title: string;
  /** What to actually do. Imperative, one action. */
  action: string;
  /** The evidence rows that triggered this. Never empty. */
  evidence: Evidence[];
}

export interface HealthReport {
  /** ISO-8601, when the collection ran. */
  generatedAt: string;
  /** Weighted mean of scored dimensions, or null when none could be scored. */
  overallScore: number | null;
  status: Status;
  dimensions: Record<DimensionId, DimensionScore>;
  recommendations: Recommendation[];
}
