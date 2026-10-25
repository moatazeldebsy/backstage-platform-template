// The Developer Experience survey — the self-reported half of DX Core 4.
//
// Core 4 pairs system metrics with what engineers report, and two of its four
// key metrics (the experience index and time spent on new capabilities) have no
// system source at all. Until this existed, the platform had zero self-reported
// data, so Effectiveness and Impact were structurally unmeasurable.
//
// The question set lives here rather than in the survey plugin so the backend
// that validates answers, the page that renders them and the scoring that reads
// them all agree on one definition — the same reason the scoring engine is its
// own package.
//
// The index is *ours*, not DX's. The DXI DX publishes is a proprietary
// instrument with its own items and benchmarks; this is a 14-driver index in the
// same spirit, labelled so that nobody compares it with DX's published numbers.

export type DriverId =
  | 'deepWork'
  | 'localIteration'
  | 'buildAndTest'
  | 'codeReview'
  | 'releaseProcess'
  | 'changeConfidence'
  | 'codeMaintainability'
  | 'documentation'
  | 'selfService'
  | 'incidentResponse'
  | 'requirementsClarity'
  | 'crossTeamCollaboration'
  | 'techDebt'
  | 'planningStability';

export type PerceptionId =
  | 'perceivedDeliveryRate'
  | 'easeOfDelivery'
  | 'perceivedQuality';

export type TimeBucket = 'newCapabilities' | 'maintenance' | 'toil' | 'other';

export interface Statement<Id extends string> {
  id: Id;
  /** Agree/disagree statement, answered on a 1–5 scale. */
  text: string;
}

/** The fourteen drivers the experience index averages over. */
export const DRIVERS: Statement<DriverId>[] = [
  { id: 'deepWork', text: 'I regularly get uninterrupted time for focused work.' },
  { id: 'localIteration', text: 'I can make a change and see it working locally within minutes.' },
  { id: 'buildAndTest', text: 'CI builds and tests are fast and reliable.' },
  { id: 'codeReview', text: 'Code reviews on my changes are timely and useful.' },
  { id: 'releaseProcess', text: 'Releasing my changes to production is easy and safe.' },
  { id: 'changeConfidence', text: 'I am confident my changes will not break production.' },
  { id: 'codeMaintainability', text: 'The code I work in is easy to understand and change.' },
  { id: 'documentation', text: 'I can find the documentation I need when I need it.' },
  { id: 'selfService', text: 'I can get infrastructure and environments without waiting on another team.' },
  { id: 'incidentResponse', text: 'When something breaks, it is easy to find out why and fix it.' },
  { id: 'requirementsClarity', text: 'Requirements are clear before I start building.' },
  { id: 'crossTeamCollaboration', text: 'I get help from other teams quickly when I need it.' },
  { id: 'techDebt', text: 'My team gets time to pay down technical debt.' },
  { id: 'planningStability', text: 'Priorities are stable enough that my work is rarely thrown away.' },
];

/** Perceived outcomes — the self-reported secondary metrics of Core 4. */
export const PERCEPTIONS: Statement<PerceptionId>[] = [
  { id: 'perceivedDeliveryRate', text: 'My team ships changes as fast as we would like to.' },
  { id: 'easeOfDelivery', text: 'Overall, it is easy for me to deliver my work.' },
  { id: 'perceivedQuality', text: 'The software my team ships is high quality.' },
];

export const TIME_BUCKETS: { id: TimeBucket; label: string }[] = [
  { id: 'newCapabilities', label: 'Building new capabilities (features, improvements users see)' },
  { id: 'maintenance', label: 'Maintenance (bugs, upgrades, tech debt)' },
  { id: 'toil', label: 'Toil (manual ops, waiting on others, firefighting)' },
  { id: 'other', label: 'Everything else (meetings, interviews, admin)' },
];

export const LIKERT_MIN = 1;
export const LIKERT_MAX = 5;

/**
 * Responses below which a group's aggregate is withheld.
 *
 * Lower than the benchmarking floor (MIN_COHORT_SIZE, 20) on purpose: that one
 * protects an organisation inside an industry cohort, this one protects a person
 * inside their own team, and most teams are smaller than twenty. Five is the
 * smallest group where one answer cannot be read back out of a mean by someone
 * who knows the other four. The same floor withholds per-team throughput.
 */
export const MIN_RESPONSES = 5;

export interface SurveyAnswers {
  drivers: Record<DriverId, number>;
  perceptions: Record<PerceptionId, number>;
  /** Whole percentages, summing to 100. */
  time: Record<TimeBucket, number>;
}

function isLikert(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= LIKERT_MIN && (v as number) <= LIKERT_MAX;
}

/**
 * Validate a submitted answer set, returning a reason when it is unusable.
 *
 * Every question is required. A partial response would be averaged over a
 * different denominator per driver, and a driver that half the team skipped
 * would read as precise as one everybody answered.
 */
export function validateAnswers(raw: unknown): { answers: SurveyAnswers } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'answers must be an object' };
  const { drivers, perceptions, time } = raw as Record<string, Record<string, unknown> | undefined>;

  for (const d of DRIVERS) {
    if (!isLikert(drivers?.[d.id])) return { error: `drivers.${d.id} must be an integer 1–5` };
  }
  for (const p of PERCEPTIONS) {
    if (!isLikert(perceptions?.[p.id])) return { error: `perceptions.${p.id} must be an integer 1–5` };
  }
  let total = 0;
  for (const b of TIME_BUCKETS) {
    const v = time?.[b.id];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100) {
      return { error: `time.${b.id} must be an integer 0–100` };
    }
    total += v as number;
  }
  if (total !== 100) return { error: `time must sum to 100, got ${total}` };

  // Rebuilt from the known ids so nothing a client adds is ever stored.
  const pick = <Id extends string>(items: { id: Id }[], from: Record<string, unknown>) =>
    Object.fromEntries(items.map(i => [i.id, from[i.id] as number])) as Record<Id, number>;
  return {
    answers: {
      drivers: pick(DRIVERS, drivers!),
      perceptions: pick(PERCEPTIONS, perceptions!),
      time: pick(TIME_BUCKETS, time!),
    },
  };
}

/** A 1–5 answer on the 0–100 scale every score uses. */
export function likertToScore(v: number): number {
  return ((v - LIKERT_MIN) / (LIKERT_MAX - LIKERT_MIN)) * 100;
}

export type SurveyAggregate =
  | { responses: number; withheld: true }
  | {
      responses: number;
      withheld: false;
      /** Mean of the fourteen driver scores, 0–100. */
      dxi: number;
      drivers: Record<DriverId, number>;
      perceptions: Record<PerceptionId, number>;
      /** Mean share of time per bucket, 0–1. */
      time: Record<TimeBucket, number>;
    };

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Aggregate a group's answers, or withhold them below the floor.
 *
 * A withheld aggregate carries the count and nothing else — not a partial, not a
 * driver or two that "look safe". The count alone is what tells a team lead to
 * chase responses rather than wonder why the card is empty.
 */
export function aggregateSurvey(
  responses: SurveyAnswers[],
  minResponses: number = MIN_RESPONSES,
): SurveyAggregate {
  const n = responses.length;
  if (n < minResponses) return { responses: n, withheld: true };

  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

  const drivers = Object.fromEntries(
    DRIVERS.map(d => [d.id, round1(mean(responses.map(r => likertToScore(r.drivers[d.id]))))]),
  ) as Record<DriverId, number>;
  const perceptions = Object.fromEntries(
    PERCEPTIONS.map(p => [p.id, round1(mean(responses.map(r => likertToScore(r.perceptions[p.id]))))]),
  ) as Record<PerceptionId, number>;
  const time = Object.fromEntries(
    TIME_BUCKETS.map(b => [b.id, round3(mean(responses.map(r => r.time[b.id] / 100)))]),
  ) as Record<TimeBucket, number>;

  return {
    responses: n,
    withheld: false,
    dxi: round1(mean(Object.values(drivers))),
    drivers,
    perceptions,
    time,
  };
}
