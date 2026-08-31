import { AiCostReport } from './aiCost';
import { MaturityAssessment } from './maturity';
import { HealthReport } from './model';

// The Engineering AI Advisor — phase 9.
//
// Two things matter more here than the model call, and both live in this file.
//
// **What the model is allowed to see.** The advisor reads the *scored report*,
// never the sources behind it. No traces, no user ids, no free text from an
// external system, no entity descriptions. A metric id, a number, a source name
// and a timestamp are enough to answer every question this is for, and anything
// beyond that is data leaving the platform for no benefit.
//
// **What it is allowed to say.** Every claim has to cite a metric that is
// actually in the context. "PR cycle time rose 31%, and Team A owns most of the
// affected services" is allowed because both halves are in the data. "Team A is
// understaffed" is not, however plausible — nothing here measures staffing, and
// a confident answer to a question the data cannot support is the single most
// damaging thing this layer could produce.
//
// Most of the questions leadership actually asks are answerable deterministically
// from the reports, and those answers are computed here rather than generated.
// An LLM that agrees with arithmetic adds nothing; an LLM that disagrees with it
// is a bug.

/** The sanitised view an advisor — human or model — is given. */
export interface AdvisorContext {
  generatedAt: string;
  overallScore: number | null;
  status: string;
  maturity: {
    level: number;
    name: string;
    confirmed: boolean;
    blockers: string[];
  };
  dimensions: {
    id: string;
    label: string;
    score: number | null;
    status: string;
    /** Metric id, value and source only. No labels, no free text. */
    evidence: { metric: string; value: number; source: string }[];
    missing: string[];
  }[];
  risks: { id: string; severity: string; title: string; action: string }[];
  gaps: { dimension: string; missing: string[] }[];
  /** Present only when spend has been collected. Totals, never trace names. */
  aiSpend?: {
    windowDays: number;
    totalUsd: number;
    attributedRatio: number | null;
    byTeam: { team: string; costUsd: number }[];
  };
  trend?: { deltaOverall: number; sinceDays: number };
}

export interface SnapshotSummary {
  capturedAt: string;
  overallScore: number | null;
  dimensions: Record<string, number | null>;
}

const DIMENSION_LABELS: Record<string, string> = {
  platform: 'Platform Engineering',
  devEx: 'Developer Experience',
  quality: 'Quality Engineering',
  reliability: 'Reliability',
  aiEngineering: 'AI Engineering',
  security: 'Security',
  finops: 'FinOps',
};

/**
 * Build the context an advisor is allowed to see.
 *
 * The omissions are the design. Evidence rows keep `metric`, `value` and
 * `source` and drop `labels`, which is where user ids, trace names and cost
 * strings live. AI spend is reduced to totals per team — the per-workload
 * breakdown and `unmatchedNames` are dropped entirely, because a raw trace name
 * is uncontrolled text from outside the platform and has no business in a
 * prompt.
 */
export function buildAdvisorContext(
  report: HealthReport,
  options: {
    gaps?: { dimension: string; missing: string[] }[];
    cost?: AiCostReport;
    snapshots?: SnapshotSummary[];
  } = {},
): AdvisorContext {
  const maturity: MaturityAssessment = report.maturity;

  const context: AdvisorContext = {
    generatedAt: report.generatedAt,
    overallScore: report.overallScore,
    status: report.status,
    maturity: {
      level: maturity.currentLevel,
      name: maturity.currentLevelName,
      confirmed: maturity.confirmed,
      blockers: (
        maturity.levels.find(l => l.level === maturity.targetLevel)
          ?.requirements ?? []
      )
        .filter(r => r.status !== 'met')
        .map(r => r.detail),
    },
    dimensions: Object.values(report.dimensions).map(d => ({
      id: d.dimension,
      label: DIMENSION_LABELS[d.dimension] ?? d.dimension,
      score: d.score,
      status: d.status,
      evidence: d.evidence.map(e => ({
        metric: e.metric,
        value: e.value,
        source: e.source,
      })),
      missing: d.missing.map(m => m.metric),
    })),
    risks: report.recommendations.map(r => ({
      id: r.id,
      severity: r.severity,
      title: r.title,
      action: r.action,
    })),
    gaps: options.gaps ?? [],
  };

  if (options.cost && options.cost.totalUsd > 0) {
    context.aiSpend = {
      windowDays: options.cost.windowDays,
      totalUsd: options.cost.totalUsd,
      attributedRatio: options.cost.attributedRatio,
      byTeam: options.cost.byTeam.map(b => ({
        team: b.key,
        costUsd: b.costUsd,
      })),
    };
  }

  const movement = overallChange(options.snapshots ?? []);
  if (movement) {
    context.trend = {
      deltaOverall: movement.delta,
      sinceDays: movement.sinceDays,
    };
  }

  return context;
}

/** Every metric id present in a context — the vocabulary a claim may cite. */
export function citableMetrics(context: AdvisorContext): Set<string> {
  const metrics = new Set<string>();
  for (const dimension of context.dimensions) {
    for (const row of dimension.evidence) metrics.add(row.metric);
    for (const missing of dimension.missing) metrics.add(missing);
  }
  return metrics;
}

/**
 * Reject a claim that cites a metric the context does not contain.
 *
 * This is the guardrail, and it is deliberately mechanical: it does not judge
 * whether an answer is *reasonable*, only whether the thing it points at exists.
 * A model that invents `devex.moraleIndex` is caught here regardless of how
 * plausible the surrounding sentence reads.
 */
export function unsupportedCitations(
  citedMetrics: string[],
  context: AdvisorContext,
): string[] {
  const known = citableMetrics(context);
  return citedMetrics.filter(m => !known.has(m));
}

export interface Change {
  delta: number;
  sinceDays: number;
  since: string;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : 0;
}

/** Movement in the overall score, or undefined when there is nothing to compare. */
export function overallChange(
  snapshots: SnapshotSummary[],
): Change | undefined {
  const scored = snapshots.filter(s => s.overallScore !== null);
  if (scored.length < 2) return undefined;
  const newest = scored[0];
  const oldest = scored[scored.length - 1];
  if (newest.capturedAt === oldest.capturedAt) return undefined;
  return {
    delta: round(
      (newest.overallScore as number) - (oldest.overallScore as number),
    ),
    sinceDays: daysBetween(oldest.capturedAt, newest.capturedAt),
    since: oldest.capturedAt,
  };
}

export interface DimensionChange {
  dimension: string;
  label: string;
  delta: number;
}

/**
 * Which dimensions moved, largest movement first.
 *
 * A dimension that was unscored at either end is omitted rather than treated as
 * zero — "we could not measure it last week" is not a decline, and reporting it
 * as one would send a team chasing a change that never happened.
 */
export function dimensionChanges(
  snapshots: SnapshotSummary[],
): DimensionChange[] {
  const scored = snapshots.filter(s => s.overallScore !== null);
  if (scored.length < 2) return [];
  const newest = scored[0];
  const oldest = scored[scored.length - 1];

  const out: DimensionChange[] = [];
  for (const [id, now] of Object.entries(newest.dimensions)) {
    const before = oldest.dimensions[id];
    if (typeof now !== 'number' || typeof before !== 'number') continue;
    if (now === before) continue;
    out.push({
      dimension: id,
      label: DIMENSION_LABELS[id] ?? id,
      delta: round(now - before),
    });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export type AdvisorQuestion =
  | 'biggest-risks'
  | 'why-changed'
  | 'focus-next'
  | 'teams-needing-attention'
  | 'ai-readiness'
  | 'reduce-cost';

export interface AdvisorAnswer {
  question: AdvisorQuestion;
  /** Plain-language answer, or the reason none can be given. */
  answer: string;
  /** Metric ids backing the answer. Empty when the answer is "not enough data". */
  citedMetrics: string[];
  /** True when the data could not support an answer. */
  insufficientEvidence: boolean;
  /** Follow-on actions, taken verbatim from the report's recommendations. */
  actions: string[];
}

function topRisks(context: AdvisorContext, limit = 3) {
  const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
  return [...context.risks]
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
    .slice(0, limit);
}

function metricsFor(context: AdvisorContext, ids: string[]): string[] {
  const known = citableMetrics(context);
  return ids.filter(id => known.has(id));
}

/**
 * Answer the questions the data can answer, arithmetically.
 *
 * Deliberately not generated. Every one of these is a lookup or a subtraction
 * over the report, and a model asked the same question could only agree with the
 * arithmetic or contradict it. Where the data does not support an answer this
 * returns `insufficientEvidence` and says what is missing, rather than producing
 * a fluent paragraph that sounds like an answer.
 */
export function answer(
  question: AdvisorQuestion,
  context: AdvisorContext,
  extra: { changes?: DimensionChange[] } = {},
): AdvisorAnswer {
  const none = (why: string): AdvisorAnswer => ({
    question,
    answer: why,
    citedMetrics: [],
    insufficientEvidence: true,
    actions: [],
  });

  switch (question) {
    case 'biggest-risks': {
      const risks = topRisks(context);
      if (risks.length === 0) {
        return none(
          `Nothing measured is currently below its target. That is not the same as no risk: ${context.gaps.length} dimension(s) could not be measured at all.`,
        );
      }
      return {
        question,
        answer: risks
          .map((r, i) => `${i + 1}. ${r.title} (${r.severity})`)
          .join('\n'),
        citedMetrics: metricsFor(
          context,
          risks.map(r => r.id),
        ),
        insufficientEvidence: false,
        actions: risks.map(r => r.action),
      };
    }

    case 'why-changed': {
      if (!context.trend) {
        return none(
          'There is no trend to explain yet. Snapshots begin at first install and cannot be back-filled, ' +
            'so at least two collections are needed.',
        );
      }
      const changes = extra.changes ?? [];
      const direction = context.trend.deltaOverall >= 0 ? 'rose' : 'fell';
      const head =
        `Overall health ${direction} ${Math.abs(context.trend.deltaOverall)} points ` +
        `over ${context.trend.sinceDays} day(s).`;
      if (changes.length === 0) {
        return {
          question,
          answer: `${head} No individual dimension changed, which means the movement came from a dimension becoming measurable or unmeasurable rather than from a score moving.`,
          citedMetrics: [],
          insufficientEvidence: false,
          actions: [],
        };
      }
      return {
        question,
        answer:
          `${head} Largest movements: ${changes
            .slice(0, 3)
            .map(c => `${c.label} ${c.delta >= 0 ? '+' : ''}${c.delta}`)
            .join(', ')}.`,
        citedMetrics: [],
        insufficientEvidence: false,
        actions: [],
      };
    }

    case 'focus-next': {
      // The gap to the next maturity level is the most defensible answer to
      // "what should we focus on" — it is the thing standing between the
      // organisation and its next level, stated by the model rather than chosen.
      if (context.maturity.blockers.length === 0) {
        return none(
          `Level ${context.maturity.level} is the highest the evidence supports, and nothing blocks the next level that can be measured.`,
        );
      }
      return {
        question,
        answer:
          `Level ${context.maturity.level + 1} is blocked by: ${context.maturity.blockers.join('; ')}`,
        citedMetrics: [],
        insufficientEvidence: false,
        actions: topRisks(context, 2).map(r => r.action),
      };
    }

    case 'teams-needing-attention': {
      // Nothing in the health model is per-team. Saying so is the answer.
      if (!context.aiSpend || context.aiSpend.byTeam.length === 0) {
        return none(
          'Engineering Health is measured platform-wide, not per team, so this cannot be answered from it. ' +
            'The only per-team figure collected is AI spend, and none has been recorded.',
        );
      }
      const top = context.aiSpend.byTeam[0];
      return {
        question,
        answer:
          `Engineering Health is platform-wide, so it cannot rank teams. The one per-team figure available is AI spend: ${top.team} accounts for the largest share at $${top.costUsd} over ${context.aiSpend.windowDays} days. That is a spend figure, not a performance one.`,
        citedMetrics: metricsFor(context, ['ai.costAttributedRatio']),
        insufficientEvidence: false,
        actions: [],
      };
    }

    case 'ai-readiness': {
      const ai = context.dimensions.find(d => d.id === 'aiEngineering');
      if (!ai || ai.score === null) {
        return none(
          `AI Engineering could not be scored. Missing: ${ai?.missing.join(', ') || 'no AI signals collected at all'}.`,
        );
      }
      return {
        question,
        answer: `AI Engineering scores ${ai.score} (${ai.status}), from ${ai.evidence.length} signal(s).`,
        citedMetrics: ai.evidence.map(e => e.metric),
        insufficientEvidence: false,
        actions: topRisks(context, 2)
          .filter(r => r.id.startsWith('ai.'))
          .map(r => r.action),
      };
    }

    case 'reduce-cost': {
      if (!context.aiSpend) {
        return none(
          'No AI spend has been recorded, and infrastructure cost is reported by OpenCost rather than attributed per team. ' +
            'There is nothing here to base a saving on.',
        );
      }
      const unattributed =
        context.aiSpend.attributedRatio !== null
          ? Math.round((1 - context.aiSpend.attributedRatio) * 100)
          : null;
      return {
        question,
        answer:
          `AI spend is $${context.aiSpend.totalUsd} over ${
            context.aiSpend.windowDays
          } days${
            unattributed !== null ? `, ${unattributed}% of it unattributed` : ''
          }. No saving figure is offered: nothing here measures workload complexity, so any "move X to a cheaper model" estimate would be invented.`,
        citedMetrics: metricsFor(context, ['ai.costAttributedRatio']),
        insufficientEvidence: false,
        actions: [],
      };
    }

    default:
      return none(`No answer is defined for '${question}'.`);
  }
}
