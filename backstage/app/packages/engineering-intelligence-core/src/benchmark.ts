import { DimensionId, HealthReport } from './model';

// Benchmarking — phase 11. **Data model and extension points only.**
//
// This file transmits nothing, and there is no implementation in this repo that
// does. That is the phase, not an omission: comparing an organisation against
// others requires consent, an anonymisation guarantee somebody is accountable
// for, and a decision about who holds the data — three product questions that
// precede any code. Shipping a working uploader first and asking them later is
// how a platform ends up exfiltrating engineering metrics by default.
//
// What is here is the shape such a thing would need, and one function that is
// useful on its own: reducing a report to the smallest thing that could ever be
// comparable, so it is obvious how little needs to leave.

/** A percentile placement, once a provider can supply one. */
export interface Percentile {
  dimension: DimensionId;
  /** The organisation's own score. */
  score: number;
  /** 0–100, or null when the cohort is too small to place it meaningfully. */
  percentile: number | null;
  /** How many organisations the placement is drawn from. */
  cohortSize: number;
}

export interface BenchmarkResult {
  generatedAt: string;
  cohort: string;
  percentiles: Percentile[];
  /** Placements withheld because the cohort was too small to anonymise. */
  withheld: DimensionId[];
}

/**
 * The minimum a cohort needs before any placement is returned.
 *
 * With a handful of participants a percentile is close to naming them: in a
 * cohort of three, "you are 33rd percentile" tells the other two exactly where
 * everyone sits. Any real provider has to enforce a floor like this, so the
 * contract states one rather than leaving it to whoever implements it.
 */
export const MIN_COHORT_SIZE = 20;

/**
 * Everything that would ever be sent, and nothing else.
 *
 * Seven numbers and a schema version. No organisation name, no team names, no
 * service names, no metric values, no evidence, no timestamps finer than a day —
 * because a score is comparable and none of the rest is. If a future provider
 * needs more than this to place a percentile, that is a reason to reconsider the
 * provider, not to widen the payload.
 */
export interface BenchmarkSubmission {
  schemaVersion: 1;
  /** Day precision. An exact timestamp is a correlation key across submissions. */
  capturedOn: string;
  scores: Partial<Record<DimensionId, number>>;
  maturityLevel: number;
}

/**
 * Reduce a report to the submission shape.
 *
 * Pure, exported, and tested — so what *would* leave the platform is inspectable
 * without running anything, and a reviewer can check the claim above by reading
 * one function rather than trusting a comment.
 */
export function toSubmission(report: HealthReport): BenchmarkSubmission {
  const scores: Partial<Record<DimensionId, number>> = {};
  for (const [id, dimension] of Object.entries(report.dimensions)) {
    // An unscored dimension is omitted rather than sent as zero. A cohort that
    // averaged those zeros would conclude the whole industry is worse at
    // Developer Experience than it is, purely because nobody measures it.
    if (dimension.score === null) continue;
    scores[id as DimensionId] = dimension.score;
  }

  return {
    schemaVersion: 1,
    capturedOn: report.generatedAt.slice(0, 10),
    scores,
    maturityLevel: report.maturity.currentLevel,
  };
}

/**
 * The extension point a hosted benchmarking service would implement.
 *
 * Deliberately an interface with no implementation in this repo. Adding one
 * means adding a network call, and that is the decision this phase defers.
 */
export interface BenchmarkProvider {
  readonly name: string;
  /** Place a submission against a cohort. */
  compare(submission: BenchmarkSubmission): Promise<BenchmarkResult>;
}

/**
 * The default provider: does nothing, and says so.
 *
 * Present so the rest of the system can be written against a provider that
 * always exists, and so "benchmarking is off" is a state with a name rather
 * than a null check scattered across call sites.
 */
export const NO_BENCHMARK_PROVIDER: BenchmarkProvider = {
  name: 'none',
  async compare(): Promise<BenchmarkResult> {
    return {
      generatedAt: new Date().toISOString(),
      cohort: 'none',
      percentiles: [],
      withheld: [],
    };
  },
};

/**
 * Place a score in a cohort, withholding when the cohort is too small.
 *
 * Here so the anonymity floor is enforced by this package rather than trusted to
 * each provider. A provider returning placements from a cohort of three would
 * have them dropped on the way through.
 */
export function placeOrWithhold(
  percentiles: Percentile[],
  minCohort: number = MIN_COHORT_SIZE,
): BenchmarkResult['percentiles'] {
  return percentiles.map(p =>
    p.cohortSize >= minCohort ? p : { ...p, percentile: null },
  );
}
