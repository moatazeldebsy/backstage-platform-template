import {
  CHANGE_FAILURE_BANDS,
  DEPLOY_FREQUENCY_BANDS,
  LEAD_TIME_BANDS,
  MTTR_BANDS,
  Normaliser,
} from './normalize';
import { DimensionId } from './model';

// Scoring policy, stated declaratively in one place.
//
// A signal is one metric's contribution to one dimension. Declaring them as data
// rather than code is what makes the engine configurable (weights can be
// overridden from app-config) and testable (the whole policy is inspectable
// without running a collection).
//
// Signals are listed here even when nothing collects them yet. That is
// deliberate: a declared-but-uncollected signal is what produces an honest
// `missing` entry naming the absent source, instead of a dimension quietly
// scoring well on the two things that happen to be measurable.

export interface Signal {
  /** Matches `MetricSample.metric` produced by a collector. */
  metric: string;
  /** Human-readable, used in recommendations and the phase-3 dashboard. */
  label: string;
  /** Relative weight within the dimension. Need not sum to 1. */
  weight: number;
  normaliser: Normaliser;
  /** The collector expected to supply it, named in `missing` when it doesn't. */
  expectedFrom: string;
  /**
   * Set when the signal measures something narrower than its label implies.
   * Copied onto every Evidence row the signal produces.
   */
  caveat?: string;
  /**
   * Normalised score below which this signal triggers a recommendation.
   * Omit for signals that should never generate one.
   */
  recommendBelow?: number;
  /** Recommendation text, required when `recommendBelow` is set. */
  recommendation?: {
    severity: 'critical' | 'warning' | 'info';
    action: string;
  };
}

export interface DimensionConfig {
  id: DimensionId;
  label: string;
  signals: Signal[];
  /**
   * Fraction of total signal weight that must produce a sample before a score
   * is emitted at all. Below it the dimension reports `insufficient-evidence`
   * with a null score.
   */
  minCoverage: number;
  /** Relative weight of this dimension in the overall Engineering Health score. */
  weight: number;
}

export const DIMENSIONS: DimensionConfig[] = [
  {
    id: 'platform',
    label: 'Platform Engineering',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'catalog.ownershipCoverage',
        label: 'Services with a declared owner',
        weight: 0.25,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'catalog',
        recommendBelow: 90,
        recommendation: {
          severity: 'warning',
          action:
            'Set spec.owner in catalog-info.yaml for the unowned Components.',
        },
      },
      {
        metric: 'catalog.goldenPathAdoption',
        label: 'Services scaffolded from a golden-path template',
        weight: 0.3,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'catalog',
        recommendBelow: 70,
        recommendation: {
          severity: 'warning',
          action:
            'Move services that were not scaffolded onto an approved golden-path template.',
        },
      },
      {
        metric: 'scorecard.goldTierRatio',
        label: 'Services at Gold scorecard tier',
        weight: 0.15,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        recommendBelow: 50,
        recommendation: {
          severity: 'info',
          action:
            'Work the Silver-tier services through their remaining scorecard checks.',
        },
      },
      {
        metric: 'dora.deployFrequencyPerDay',
        label: 'Deployment frequency',
        weight: 0.15,
        normaliser: DEPLOY_FREQUENCY_BANDS,
        expectedFrom: 'prometheus',
      },
      {
        // Adoption says how many services came from a template. This says
        // whether the scaffolder works when someone uses it — a platform whose
        // templates fail half the time is not self-service, however good its
        // adoption number looks.
        metric: 'scaffolder.taskSuccessRatio',
        label: 'Self-service scaffolder success rate',
        weight: 0.15,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'scaffolder',
        recommendBelow: 90,
        recommendation: {
          severity: 'critical',
          action:
            'Investigate failing scaffolder tasks — self-service is the platform\'s front door.',
        },
      },
    ],
  },
  {
    id: 'devEx',
    label: 'Developer Experience',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      // All four are collected as of phase 5. The DORA exporter CronJob computes
      // the three devex_* series from the GitHub workflow runs it already
      // fetches plus one bounded pull-request query, and omits a series rather
      // than pushing 0.0 when nothing merged or nothing ran.
      {
        metric: 'dora.leadTimeMinutes',
        label: 'Deployment lead time',
        weight: 0.25,
        normaliser: LEAD_TIME_BANDS,
        expectedFrom: 'prometheus',
      },
      {
        metric: 'devex.prCycleTimeHours',
        label: 'PR cycle time',
        weight: 0.3,
        normaliser: { kind: 'inverseLinear', min: 4, max: 120 },
        expectedFrom: 'prometheus (devex_* from the DORA exporter)',
      },
      {
        metric: 'devex.ciDurationMinutes',
        label: 'CI duration',
        weight: 0.25,
        normaliser: { kind: 'inverseLinear', min: 5, max: 60 },
        expectedFrom: 'prometheus (devex_* from the DORA exporter)',
      },
      {
        metric: 'devex.buildFailureRatio',
        label: 'CI build failure rate',
        weight: 0.2,
        normaliser: { kind: 'inverseLinear', min: 0.02, max: 0.3 },
        expectedFrom: 'prometheus (devex_* from the DORA exporter)',
      },
    ],
  },
  {
    id: 'quality',
    label: 'Quality Engineering',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'scorecard.checksPassedRatio',
        label: 'Scorecard checks passing',
        weight: 0.4,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        recommendBelow: 70,
        recommendation: {
          severity: 'warning',
          action:
            'Close the most common failing scorecard check across the catalog.',
        },
      },
      {
        metric: 'test.flakinessRatio',
        label: 'Test flakiness',
        weight: 0.3,
        normaliser: { kind: 'inverseLinear', min: 0.01, max: 0.2 },
        expectedFrom: 'prometheus',
        recommendBelow: 60,
        recommendation: {
          severity: 'warning',
          action:
            'Quarantine the flakiest suites — see docs/flaky-test-quarantine.md.',
        },
      },
      {
        metric: 'test.passRate',
        label: 'Test pass rate',
        weight: 0.3,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'prometheus',
      },
      // Deliberately absent: code coverage and e2e pass rate. Both appear on the
      // QA Grafana dashboard, but the only thing that ever writes them is
      // scripts/seed-qa-metrics.sh — they are demo values, not measurements.
    ],
  },
  {
    id: 'reliability',
    label: 'Reliability',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'dora.changeFailureRatePercent',
        label: 'Change failure rate',
        weight: 0.5,
        normaliser: CHANGE_FAILURE_BANDS,
        expectedFrom: 'prometheus',
        recommendBelow: 75,
        recommendation: {
          severity: 'critical',
          action:
            'Investigate the services driving failed deployments before adding release volume.',
        },
      },
      {
        metric: 'dora.mttrMinutes',
        label: 'Mean time to restore',
        weight: 0.5,
        normaliser: MTTR_BANDS,
        expectedFrom: 'prometheus',
        recommendBelow: 75,
        recommendation: {
          severity: 'warning',
          action:
            'Review incident response and rollback paths for the slowest services.',
        },
      },
      // SLO error-budget signals are not declared: Sloth rules exist for
      // hello-service alone, so a platform-wide SLO score would describe one
      // service and imply it described all of them.
    ],
  },
  {
    id: 'aiEngineering',
    label: 'AI Engineering',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'ai.governanceChecksRatio',
        label: 'AI services meeting governance checks',
        weight: 0.5,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        caveat:
          'Measures the model-card, eval-suite and AI-observability scorecard checks.',
        recommendBelow: 60,
        recommendation: {
          severity: 'critical',
          action:
            'Add an LLM evaluation suite and model card to the AI services missing them.',
        },
      },
      {
        metric: 'ai.observabilityActive',
        label: 'LLM observability receiving traces',
        weight: 0.2,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'langfuse',
        // Binary on purpose. Langfuse traces here carry a name, a session id and
        // a user id, but no key that joins back to a catalog entity or a team —
        // so "percentage of AI services under observation" cannot be measured,
        // only guessed. Per-service attribution is phase 8 and needs a join key
        // added at the emitting end first.
        caveat:
          'Platform-level presence, not per-service coverage. Langfuse traces carry no catalog or team attribution.',
        recommendBelow: 100,
        recommendation: {
          severity: 'warning',
          action:
            'No LLM traces in the last 7 days — set LANGFUSE_OTLP_ENDPOINT on the AI workloads.',
        },
      },
      {
        metric: 'ai.mcpToolSuccessRatio',
        label: 'MCP tool call success rate',
        weight: 0.3,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'prometheus',
      },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'security.scanningControlsRatio',
        label: 'Services declaring SonarCloud, Snyk and Trivy scanning',
        weight: 1,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'techInsights',
        // The honesty that keeps this dimension defensible. Nothing in the
        // platform exports vulnerability counts to a queryable store; the
        // scorecard checks observe that a scanner is wired up, not what it found.
        caveat:
          'Control presence, not finding count. No vulnerability, policy-violation or secret-rotation data is trended anywhere in the platform.',
        recommendBelow: 80,
        recommendation: {
          severity: 'warning',
          action:
            'Run the enable-security-scanning scaffolder on services with no scanner declared.',
        },
      },
    ],
  },
  {
    id: 'finops',
    label: 'FinOps',
    weight: 1,
    minCoverage: 0.5,
    signals: [
      {
        metric: 'finops.budgetUtilisationRatio',
        label: 'Team budget utilisation',
        weight: 0.5,
        // Under budget is good, over is bad, and 0 is not better than 0.7 —
        // but with no notion of planned spend the honest reading is simply
        // "how close to the ceiling", scored inversely from 70% upward.
        normaliser: { kind: 'inverseLinear', min: 0.7, max: 1.2 },
        expectedFrom: 'prometheus',
        recommendBelow: 50,
        recommendation: {
          severity: 'critical',
          action:
            'Review the teams above budget — see the cost-mcp-server list_budget_overruns tool.',
        },
      },
      {
        metric: 'finops.costEfficiencyRatio',
        label: 'Requested-vs-used resource efficiency',
        weight: 0.5,
        normaliser: { kind: 'ratio' },
        expectedFrom: 'opencost',
        recommendBelow: 60,
        recommendation: {
          severity: 'warning',
          action:
            'Apply the OpenCost rightsizing recommendations to over-provisioned workloads.',
        },
      },
    ],
  },
];

export function dimensionConfig(id: DimensionId): DimensionConfig {
  const found = DIMENSIONS.find(d => d.id === id);
  if (!found) throw new Error(`unknown dimension: ${id}`);
  return found;
}
