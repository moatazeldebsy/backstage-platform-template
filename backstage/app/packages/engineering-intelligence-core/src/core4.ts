import { DIMENSIONS, DimensionConfig, Signal } from './dimensions';
import { MIN_RESPONSES, SurveyAggregate } from './devexSurvey';
import { DimensionScore, Evidence, MetricSample } from './model';
import { scoreDimension } from './score';

// DX Core 4 — a lens over the same samples, not an eighth dimension.
//
// Core 4 (Speed, Effectiveness, Quality, Impact) is a framework leadership
// already recognises, so the platform presents its data that way rather than
// asking leaders to learn the seven-dimension model. It is scored by the same
// `scoreDimension` the health model and AI readiness use: one implementation of
// normalisation, coverage and the insufficient-evidence rule, three models.
//
// Two things here are deliberate departures from the other models:
//
// - **No overall score.** Core 4 is four numbers read together, and the
//   framework's whole point is that speed is never read without the experience
//   index beside it. A single roll-up would invite exactly the reading it warns
//   against.
// - **Each area names a key metric** and reports it on its own, raw, alongside
//   the area score. Leadership reads "2.8 PRs per engineer per week", not "71".
//
// Items Core 4 lists that no platform can observe — attrition, revenue per
// engineer — are declared as `notMeasured` so the page says so, rather than
// leaving the reader to assume they were forgotten.

export type Core4AreaId = 'speed' | 'effectiveness' | 'quality' | 'impact';

export const CORE4_AREA_IDS: Core4AreaId[] = ['speed', 'effectiveness', 'quality', 'impact'];

export interface NotMeasured {
  label: string;
  reason: string;
}

export interface Core4AreaConfig extends DimensionConfig<Core4AreaId> {
  /** The question the area answers, in leadership's words. */
  question: string;
  /** The Core 4 key metric — must be one of `signals`. */
  keyMetric: string;
  notMeasured: NotMeasured[];
}

/**
 * A signal already declared by the health model, re-weighted for Core 4.
 *
 * Copied rather than redeclared so the DORA bands and the security caveat are
 * stated once — a second copy of LEAD_TIME_BANDS here would be the scorecard's
 * three-way drift all over again.
 */
function reuse(metric: string, weight: number): Signal {
  for (const dimension of DIMENSIONS) {
    const signal = dimension.signals.find(s => s.metric === metric);
    if (signal) {
      const { recommendBelow, recommendation, ...rest } = signal;
      return { ...rest, weight };
    }
  }
  throw new Error(`core4: no health-model signal named ${metric}`);
}

const SURVEY = 'devex-survey';
const SCORE_0_100 = { kind: 'linear', min: 0, max: 100 } as const;

export const CORE4_AREAS: Core4AreaConfig[] = [
  {
    id: 'speed',
    label: 'Speed',
    question: 'How quickly does work move from idea to production?',
    weight: 1,
    minCoverage: 0.4,
    keyMetric: 'core4.diffsPerEngineerWeekly',
    signals: [
      {
        metric: 'core4.diffsPerEngineerWeekly',
        label: 'Merged PRs per engineer per week',
        weight: 0.4,
        // A judgement, and the softest one on this page: half a PR a week scores
        // 0 and four scores 100. It exists so the area can be read at all, never
        // as a target — Core 4 is explicit that diffs per engineer is only safe
        // counterbalanced by the experience index and never tied to rewards.
        normaliser: { kind: 'linear', min: 0.5, max: 4 },
        expectedFrom: 'prometheus (devex_prs_merged_weekly) ÷ catalog Group members',
        caveat:
          'Team rate, never per person. Counterbalance with the experience index; do not set targets on it.',
      },
      reuse('dora.leadTimeMinutes', 0.2),
      reuse('dora.deployFrequencyPerDay', 0.2),
      {
        metric: 'survey.perceivedDeliveryRate',
        label: 'Perceived rate of delivery',
        weight: 0.2,
        normaliser: SCORE_0_100,
        expectedFrom: SURVEY,
      },
    ],
    notMeasured: [],
  },
  {
    id: 'effectiveness',
    label: 'Effectiveness',
    question: 'How easily can engineers do their best work?',
    weight: 1,
    minCoverage: 0.5,
    keyMetric: 'survey.dxi',
    signals: [
      {
        metric: 'survey.dxi',
        label: 'Developer Experience Index (platform)',
        weight: 0.7,
        normaliser: SCORE_0_100,
        expectedFrom: SURVEY,
        caveat:
          "This platform's own 14-driver index, not DX's proprietary DXI — do not compare with DX benchmarks.",
      },
      {
        metric: 'survey.easeOfDelivery',
        label: 'Ease of delivery',
        weight: 0.3,
        normaliser: SCORE_0_100,
        expectedFrom: SURVEY,
      },
    ],
    notMeasured: [
      {
        label: 'Time to 10th PR',
        reason: 'Needs each engineer\'s start date; the catalog does not record one.',
      },
      {
        label: 'Regrettable attrition',
        reason: 'HR data. The platform has no source for it, and should not.',
      },
    ],
  },
  {
    id: 'quality',
    label: 'Quality',
    question: 'How reliable is what we ship?',
    weight: 1,
    minCoverage: 0.4,
    keyMetric: 'dora.changeFailureRatePercent',
    signals: [
      reuse('dora.changeFailureRatePercent', 0.4),
      reuse('dora.mttrMinutes', 0.25),
      {
        metric: 'survey.perceivedQuality',
        label: 'Perceived software quality',
        weight: 0.2,
        normaliser: SCORE_0_100,
        expectedFrom: SURVEY,
      },
      reuse('security.scanningControlsRatio', 0.15),
    ],
    notMeasured: [],
  },
  {
    id: 'impact',
    label: 'Impact',
    question: 'How much engineering time goes into new value?',
    weight: 1,
    minCoverage: 0.5,
    keyMetric: 'survey.newCapabilitiesRatio',
    signals: [
      {
        metric: 'survey.newCapabilitiesRatio',
        label: 'Time spent on new capabilities',
        weight: 1,
        // 20% scores 0 and 60% scores 100. A judgement: below a fifth, most of
        // the team's time is going to keeping the lights on; above three fifths
        // there is little left to add.
        normaliser: { kind: 'linear', min: 0.2, max: 0.6 },
        expectedFrom: SURVEY,
        caveat: 'Self-reported time allocation, averaged across respondents.',
      },
    ],
    notMeasured: [
      {
        label: 'Initiative progress and ROI',
        reason: 'Needs a portfolio or planning system; none is connected.',
      },
      {
        label: 'Revenue per engineer, R&D as % of revenue',
        reason: 'Finance data. Reported to leadership by Finance, not by the platform.',
      },
    ],
  },
];

export interface Core4Area extends DimensionScore<Core4AreaId> {
  label: string;
  question: string;
  keyMetric: string;
  keyLabel: string;
  /** The key metric's evidence row, or null when it was not observed. */
  key: Evidence | null;
  notMeasured: NotMeasured[];
}

/** What a collector knows about one team, before the floor is applied. */
export interface Core4TeamInput {
  team: string;
  /** Group members in the catalog. */
  engineers?: number;
  /** Merged PRs per week across the services the team owns. */
  mergedPrsWeekly?: number;
  survey?: SurveyAggregate;
}

/**
 * One row of the team breakdown.
 *
 * Every value is null below the floor rather than omitted, so the table can say
 * "withheld" in the cell instead of rendering a shorter row that looks complete.
 */
export interface Core4TeamRow {
  team: string;
  engineers: number | null;
  diffsPerEngineerWeekly: number | null;
  responses: number;
  dxi: number | null;
  newCapabilitiesRatio: number | null;
  /** True when anything on the row was suppressed by the floor. */
  withheld: boolean;
}

export interface Core4Report {
  generatedAt: string;
  areas: Record<Core4AreaId, Core4Area>;
  teams: Core4TeamRow[];
  /** The group-size floor applied to the team rows. */
  minCohort: number;
  guardrail: string;
}

export const CORE4_GUARDRAIL =
  'Team-level only. Not for evaluating individuals, and not for setting targets — especially on diffs per engineer.';

const round2 = (v: number) => Math.round(v * 100) / 100;

export function core4TeamRows(
  inputs: Core4TeamInput[],
  minCohort: number = MIN_RESPONSES,
): Core4TeamRow[] {
  return inputs
    .map(input => {
      const engineers = input.engineers ?? null;
      // A team of two's "per engineer" figure is two people's output with a
      // division sign in front of it. The survey floor applies here too.
      const bigEnough = engineers !== null && engineers >= minCohort;
      const diffs =
        bigEnough && input.mergedPrsWeekly !== undefined
          ? round2(input.mergedPrsWeekly / engineers)
          : null;
      const survey = input.survey;
      const surveyShown = survey && !survey.withheld ? survey : undefined;
      return {
        team: input.team,
        engineers,
        diffsPerEngineerWeekly: diffs,
        responses: survey?.responses ?? 0,
        dxi: surveyShown?.dxi ?? null,
        newCapabilitiesRatio: surveyShown?.time.newCapabilities ?? null,
        withheld:
          (engineers !== null && !bigEnough && input.mergedPrsWeekly !== undefined) ||
          (!!survey && survey.withheld && survey.responses > 0),
      };
    })
    .sort((a, b) => a.team.localeCompare(b.team));
}

export function scoreCore4(
  samples: MetricSample[],
  options: { generatedAt?: string; teams?: Core4TeamInput[]; minCohort?: number } = {},
): Core4Report {
  const minCohort = options.minCohort ?? MIN_RESPONSES;
  const areas = {} as Record<Core4AreaId, Core4Area>;
  for (const config of CORE4_AREAS) {
    const scored = scoreDimension(config, samples);
    const keySignal = config.signals.find(s => s.metric === config.keyMetric)!;
    areas[config.id] = {
      ...scored,
      label: config.label,
      question: config.question,
      keyMetric: config.keyMetric,
      keyLabel: keySignal.label,
      key: scored.evidence.find(e => e.metric === config.keyMetric) ?? null,
      notMeasured: config.notMeasured,
    };
  }
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    areas,
    teams: core4TeamRows(options.teams ?? [], minCohort),
    minCohort,
    guardrail: CORE4_GUARDRAIL,
  };
}

export interface Core4Change {
  area: Core4AreaId;
  label: string;
  /** Area score movement, or null when either side was unscored. */
  delta: number | null;
  /** The key metric then and now, in its own units. */
  keyBefore: number | null;
  keyNow: number | null;
}

/**
 * Movement between two Core 4 reports, area by area.
 *
 * An area unscored on either side has a null delta rather than one computed
 * against zero — "Effectiveness +64" on the quarter the survey started would be
 * the survey arriving, not engineers' experience improving.
 */
export function core4Changes(now: Core4Report, before: Core4Report): Core4Change[] {
  return CORE4_AREA_IDS.map(id => {
    const a = now.areas[id];
    const b = before.areas?.[id];
    const scoreNow = a?.score ?? null;
    const scoreBefore = b?.score ?? null;
    const delta =
      scoreNow !== null && scoreBefore !== null
        ? Math.round((scoreNow - scoreBefore) * 10) / 10
        : null;
    return {
      area: id,
      label: a?.label ?? id,
      delta,
      keyBefore: b?.key?.value ?? null,
      keyNow: a?.key?.value ?? null,
    };
  });
}
