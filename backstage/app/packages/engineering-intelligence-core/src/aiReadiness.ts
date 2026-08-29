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
    // Lower than the others on purpose. Results carry 0.7 of this area's weight,
    // so a platform with suites but no results — the common case, since
    // push_to_langfuse.py only reaches a publicly reachable Langfuse — would
    // otherwise fall under the usual 0.5 bar and report no score at all. Suite
    // presence is weak evidence, not absent evidence, and it arrives caveated.
    minCoverage: 0.3,
    signals: [
      {
        // Phase 7. Results, not presence — this is what the suite actually found.
        // Weighted above presence deliberately: a declared suite that fails is
        // worse than no suite, because it looks like coverage.
        metric: 'ai.evalPassRatio',
        label: 'Evaluation assertions passing',
        weight: 0.7,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'langfuse-scores',
        recommendBelow: 90,
        recommendation: {
          severity: 'critical',
          action:
            'Investigate the failing evaluation assertions before shipping further model or prompt changes.',
        },
      },
      {
        metric: 'ai.evalSuiteRatio',
        label: 'AI services with an evaluation suite in CI',
        weight: 0.3,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        // The caveat now lives on this signal alone rather than the whole area:
        // it observes that a suite is declared, not what it found. When
        // ai.evalPassRatio is present the area is no longer presence-only.
        caveat:
          'Suite presence, not results — the pass-rate signal alongside it carries the outcomes.',
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
        // Phase 7 gave this a source, but only for organisations that actually
        // run adversarial evals. With none, the area still reports insufficient
        // evidence — an untested risk is unknown, not absent.
        metric: 'ai.evalPromptInjectionRatio',
        label: 'Prompt-injection assertions passing',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'langfuse-scores (needs an adversarial eval suite)',
        recommendBelow: 100,
        recommendation: {
          severity: 'critical',
          action:
            'A prompt-injection assertion is failing — treat it as a live vulnerability, not a test failure.',
        },
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
        metric: 'ai.evalPiiSafetyRatio',
        label: 'PII-safety assertions passing',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'langfuse-scores (needs a PII eval suite)',
        recommendBelow: 100,
        recommendation: {
          severity: 'critical',
          action:
            'A PII-safety assertion is failing — this is a data-protection issue, not a flaky test.',
        },
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
        metric: 'ai.evalRegressionRatio',
        label: 'Regression assertions passing',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'langfuse-scores (needs regression evals)',
        recommendBelow: 95,
        recommendation: {
          severity: 'warning',
          action:
            'A regression assertion is failing — a model or prompt change moved behaviour that used to be pinned.',
        },
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
        expectedFrom: 'ai-cost',
        // Attribution is by naming convention, not an explicit key: a trace is
        // joined to a catalog entity through its name. A workload whose name
        // matches nothing is reported as unattributed rather than guessed at.
        caveat:
          'Attribution joins trace names to catalog entities by convention. Unmatched spend is reported, never redistributed.',
        recommendBelow: 80,
        recommendation: {
          severity: 'warning',
          action:
            'Align agent and MCP trace names with their catalog entity names — unattributed AI spend has no owner to act on it.',
        },
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
