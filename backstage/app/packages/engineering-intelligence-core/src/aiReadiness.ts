import { DimensionConfig } from './dimensions';
import { DimensionScore, MetricSample, Status } from './model';
import { scoreDimension } from './score';

// AI Engineering Readiness — a second scored model, over the same engine.
//
// Where the Engineering Health model asks "how is the organisation doing", this
// asks the narrower question a team needs answered before putting an AI system
// in front of customers: is it evaluated, observed, governed, and are its models
// and prompts managed rather than pasted?
//
// It reuses `scoreDimension` rather than reimplementing it. That is the whole
// reason the scoring functions are generic over their area id — a second model
// with its own weights and thresholds, but one implementation of normalisation,
// coverage, evidence and the insufficient-evidence rule. This repo already
// demonstrates what the alternative looks like: the Bronze/Silver/Gold scorecard
// exists three times and has drifted.
//
// Five of the twelve areas below have no collector. They are declared anyway, so
// the gap is reported with the source it needs rather than quietly omitted —
// the same argument as the DevEx signals before phase 5 filled them in.

export type AiReadinessAreaId =
  | 'governance'
  | 'evaluation'
  | 'observability'
  | 'modelManagement'
  | 'promptManagement'
  | 'reliability'
  | 'security'
  | 'privacy'
  | 'architecture'
  | 'testing'
  | 'cost'
  | 'incidentManagement';

export const AI_READINESS_AREAS: DimensionConfig<AiReadinessAreaId>[] = [
  {
    id: 'governance',
    label: 'AI Governance',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.modelCardRatio',
        label: 'AI services with a model card',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        recommendBelow: 70,
        recommendation: {
          severity: 'critical',
          action:
            'Add a model card documenting training data, limitations and intended use to the AI services missing one.',
        },
      },
    ],
  },
  {
    id: 'evaluation',
    label: 'Evaluation',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.evalSuiteRatio',
        label: 'AI services with an evaluation suite in CI',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        // The honest limit of this signal, and the reason phase 7 exists: it
        // observes that a suite is declared, not what the suite found. A service
        // whose evals all fail scores identically to one whose evals all pass.
        caveat:
          'Suite presence, not results. Evaluation outcomes are not trended anywhere yet — see phase 7.',
        recommendBelow: 60,
        recommendation: {
          severity: 'critical',
          action:
            'Run the deepeval-llm-eval-suite scaffolder on the AI services with no evaluation suite.',
        },
      },
    ],
  },
  {
    id: 'observability',
    label: 'Observability',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.observabilityWiredRatio',
        label: 'AI services with observability wired',
        weight: 0.6,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        recommendBelow: 70,
        recommendation: {
          severity: 'warning',
          action:
            'Set LANGFUSE_OTLP_ENDPOINT on the AI services that are not exporting traces.',
        },
      },
      {
        metric: 'ai.observabilityActive',
        label: 'LLM traces reaching the backend',
        weight: 0.4,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'langfuse',
        caveat:
          'Platform-level presence, not per-service coverage. Langfuse traces carry no catalog or team attribution.',
      },
    ],
  },
  {
    id: 'modelManagement',
    label: 'Model Management',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.modelVersionedRatio',
        label: 'Registered models carrying at least one version',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'mlflow',
        // A registered name with no versions is a placeholder, not a managed
        // model — it is the registry equivalent of an empty repository.
        recommendBelow: 80,
        recommendation: {
          severity: 'warning',
          action:
            'Register a version for the models that exist in name only, or remove them from the registry.',
        },
      },
    ],
  },
  {
    id: 'promptManagement',
    label: 'Prompt Management',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.promptsManagedRatio',
        label: 'Agent prompts under version control in Langfuse',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'langfuse',
        recommendBelow: 80,
        recommendation: {
          severity: 'warning',
          action:
            'Push the unmanaged agent prompts to Langfuse with scripts/sync-agent-prompts.py --push.',
        },
      },
    ],
  },
  {
    id: 'reliability',
    label: 'Reliability',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.mcpToolSuccessRatio',
        label: 'MCP tool call success rate',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'prometheus',
        recommendBelow: 95,
        recommendation: {
          severity: 'warning',
          action:
            'Investigate the failing MCP tool calls — agents degrade silently when a tool errors.',
        },
      },
    ],
  },

  // ── Declared, with nothing behind them ──────────────────────────────────────
  // Each names the collector it is waiting on. Reporting these as gaps is the
  // point: a readiness score built only from the measurable half would flatter
  // an organisation that has done none of the hard parts.
  {
    id: 'security',
    label: 'AI Security',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.promptInjectionTested',
        label: 'Prompt-injection resistance tested',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'not collected — needs an adversarial suite (phase 7)',
      },
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.piiLeakageTested',
        label: 'PII leakage tested',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'not collected — needs a PII evaluation (phase 7)',
      },
    ],
  },
  {
    id: 'architecture',
    label: 'AI Architecture',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.architectureReviewed',
        label: 'AI services with a reviewed architecture',
        weight: 1,
        normaliser: { kind: 'ratio' },
        // Deliberately has no plausible automatic source. Architecture quality is
        // a judgement, and inventing a proxy for it — counting annotations, say —
        // would be the most dishonest number on this page.
        expectedFrom: 'not collected — requires human review, not a metric',
      },
    ],
  },
  {
    id: 'testing',
    label: 'AI Testing',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.regressionSuiteRatio',
        label: 'AI services with regression tests over model changes',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'not collected — needs eval results over time (phase 7)',
      },
    ],
  },
  {
    id: 'cost',
    label: 'AI Cost Management',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.costAttributedRatio',
        label: 'AI spend attributable to a team',
        weight: 1,
        normaliser: { kind: 'ratio' },
        // Langfuse records cost per model and per trace, but nothing joins a
        // trace back to an owning team. The join key has to be emitted at source
        // in services/*/src/telemetry.ts before this is anything but a guess.
        expectedFrom: 'not collected — needs trace attribution (phase 8)',
      },
    ],
  },
  {
    id: 'incidentManagement',
    label: 'AI Incident Management',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.incidentResponseRatio',
        label: 'AI incidents with a recorded response',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'not collected — incidents carry no AI classification',
      },
    ],
  },
];

export interface AiReadinessReport {
  generatedAt: string;
  /** Weighted mean of the areas that could be scored, or null when none could. */
  overallScore: number | null;
  status: Status;
  areas: Record<AiReadinessAreaId, DimensionScore<AiReadinessAreaId>>;
  /** How many of the twelve areas any data exists for. */
  measurable: number;
  total: number;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function scoreAiReadiness(
  samples: MetricSample[],
  generatedAt: string = new Date().toISOString(),
): AiReadinessReport {
  const areas = {} as Record<
    AiReadinessAreaId,
    DimensionScore<AiReadinessAreaId>
  >;
  for (const config of AI_READINESS_AREAS) {
    areas[config.id] = scoreDimension(config, samples);
  }

  const scored = AI_READINESS_AREAS.map(c => areas[c.id]).filter(
    a => a.score !== null,
  );

  // Unscored areas are excluded, never counted as zero — the same rule the
  // Engineering Health model follows. With five areas structurally uncollectable
  // today, zeroing them would peg every organisation's AI readiness below 60
  // regardless of what it had actually done.
  const overallScore = scored.length
    ? round(scored.reduce((t, a) => t + (a.score as number), 0) / scored.length)
    : null;

  let status: Status = 'partial';
  if (scored.length === 0) status = 'insufficient-evidence';
  else if (scored.length === AI_READINESS_AREAS.length) status = 'ok';

  return {
    generatedAt,
    overallScore,
    status,
    areas,
    measurable: scored.length,
    total: AI_READINESS_AREAS.length,
  };
}
