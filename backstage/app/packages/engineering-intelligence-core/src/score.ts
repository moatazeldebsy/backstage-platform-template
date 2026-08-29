import {
  DIMENSION_IDS,
  DimensionId,
  DimensionScore,
  Evidence,
  HealthReport,
  MetricSample,
  MissingSignal,
  Status,
} from './model';
import { DIMENSIONS, DimensionConfig, Signal } from './dimensions';
import { normalise } from './normalize';
import { recommend } from './recommend';
import { assessMaturity } from './maturity';

/**
 * The share of a model's areas that must be scored before a headline number is
 * given at all.
 *
 * A mean over one area out of twelve is arithmetically fine and editorially a
 * lie: it reads as an assessment of the whole model. The dimensions already
 * refuse to score from too few signals; this is the same rule one level up, so
 * "we measured a third of this" is the floor for saying anything about the whole.
 *
 * A third rather than a half because the unmeasurable areas are not evenly
 * spread — six of the twelve AI readiness areas have no collector by design, so
 * a half would make that model permanently unscoreable rather than merely
 * demanding.
 */
export const MIN_SCORED_FRACTION = 1 / 3;

/** Optional per-dimension weight overrides, supplied from app-config. */
export type WeightOverrides = Partial<Record<DimensionId, number>>;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function sampleFor(
  samples: MetricSample[],
  metric: string,
): MetricSample | undefined {
  // Collectors emit at most one sample per metric id — they aggregate across
  // services themselves, since a dimension score is a platform-wide figure.
  // If that ever changes, taking the most recently observed is the honest
  // tiebreak rather than the first one collected.
  const matches = samples.filter(s => s.metric === metric);
  if (matches.length === 0) return undefined;
  return matches.reduce((newest, s) =>
    Date.parse(s.observedAt) > Date.parse(newest.observedAt) ? s : newest,
  );
}

function missingFor(signal: Signal): MissingSignal {
  return {
    metric: signal.metric,
    expectedFrom: signal.expectedFrom,
    reason: `No sample was collected for ${signal.metric}.`,
  };
}

/**
 * Score one dimension from whatever samples were collected.
 *
 * The weighted mean is taken over the signals that produced a sample, so a
 * missing signal lowers `coverage` rather than dragging the score toward zero —
 * an absent measurement is not the same as a bad one. Once coverage falls below
 * the dimension's `minCoverage` the score is withheld entirely.
 */
export function scoreDimension<Id extends string>(
  config: DimensionConfig<Id>,
  samples: MetricSample[],
): DimensionScore<Id> {
  const evidence: Evidence[] = [];
  const missing: MissingSignal[] = [];

  const totalWeight = config.signals.reduce((sum, s) => sum + s.weight, 0);
  let presentWeight = 0;

  for (const signal of config.signals) {
    const sample = sampleFor(samples, signal.metric);
    if (!sample) {
      missing.push(missingFor(signal));
      continue;
    }
    presentWeight += signal.weight;
    evidence.push({
      metric: signal.metric,
      value: sample.value,
      normalised: round(normalise(sample.value, signal.normaliser)),
      source: sample.source,
      observedAt: sample.observedAt,
      // Provisional — rewritten below, once the divisor is known.
      impact: 0,
      ...(signal.caveat ? { caveat: signal.caveat } : {}),
    });
  }

  const coverage = totalWeight === 0 ? 0 : presentWeight / totalWeight;

  if (coverage < config.minCoverage || presentWeight === 0) {
    return {
      dimension: config.id,
      score: null,
      status: 'insufficient-evidence',
      coverage: round(coverage * 100) / 100,
      // Evidence is still returned when it exists: the reader should be able to
      // see what *was* measured and judge the gap, not just be told there's one.
      evidence: evidence.map(e => ({ ...e, impact: 0 })),
      missing,
    };
  }

  // Impact is the signal's weighted share of the score, normalised over the
  // weight that was actually present. The impacts therefore sum to the score,
  // which is the property that makes the number explainable — asserted in
  // score.test.ts.
  let score = 0;
  for (const row of evidence) {
    const signal = config.signals.find(s => s.metric === row.metric)!;
    const impact = (row.normalised * signal.weight) / presentWeight;
    row.impact = round(impact);
    score += impact;
  }

  const status: Status = missing.length === 0 ? 'ok' : 'partial';

  return {
    dimension: config.id,
    score: round(score),
    status,
    coverage: round(coverage * 100) / 100,
    evidence,
    missing,
  };
}

/**
 * Score every dimension and roll them up into one Engineering Health report.
 *
 * The overall score is the weighted mean of the dimensions that could be
 * scored. Dimensions reporting `insufficient-evidence` are excluded rather than
 * counted as zero — with Developer Experience currently uncollectable, treating
 * it as a zero would understate platform health by roughly fourteen points and
 * would keep doing so until phase 5 lands.
 */
export function scoreHealth(
  samples: MetricSample[],
  options: { generatedAt?: string; weights?: WeightOverrides } = {},
): HealthReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dimensions = {} as Record<DimensionId, DimensionScore>;

  for (const config of DIMENSIONS) {
    dimensions[config.id] = scoreDimension(config, samples);
  }

  let weighted = 0;
  let weightSum = 0;
  for (const config of DIMENSIONS) {
    const scored = dimensions[config.id];
    if (scored.score === null) continue;
    const weight = options.weights?.[config.id] ?? config.weight;
    weighted += scored.score * weight;
    weightSum += weight;
  }

  const scoredCount = DIMENSION_IDS.filter(
    id => dimensions[id].score !== null,
  ).length;

  // Too few dimensions scored to characterise the whole. Reported the same way
  // a dimension with too few signals is: no number, and the count so a reader
  // can see how thin the evidence was.
  const tooFewScored =
    scoredCount < Math.ceil(DIMENSION_IDS.length * MIN_SCORED_FRACTION);

  let status: Status = 'partial';
  if (weightSum === 0 || tooFewScored) {
    status = 'insufficient-evidence';
  } else if (scoredCount === DIMENSION_IDS.length) {
    status = 'ok';
  }

  const recommendations = recommend(dimensions);

  return {
    generatedAt,
    overallScore:
      weightSum === 0 || tooFewScored ? null : round(weighted / weightSum),
    status,
    dimensions,
    recommendations,
    maturity: assessMaturity(dimensions, recommendations),
  };
}
