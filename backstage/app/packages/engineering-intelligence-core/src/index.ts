// Engineering Intelligence — the scoring engine.
//
// Framework-free by design: nothing here imports Backstage. The
// `engineering-intelligence` backend plugin supplies collected samples and
// serves the result; the dashboard (phase 3) and the AI Advisor (phase 9) will
// read the same structures. See docs/engineering-intelligence/scoring.md.

export type {
  DimensionId,
  DimensionScore,
  Evidence,
  HealthReport,
  MetricSample,
  MissingSignal,
  Recommendation,
  Status,
} from './model';
export { DIMENSION_IDS } from './model';

export type { DimensionConfig, Signal } from './dimensions';
export { DIMENSIONS, dimensionConfig } from './dimensions';

export type { Normaliser } from './normalize';
export {
  CHANGE_FAILURE_BANDS,
  DEPLOY_FREQUENCY_BANDS,
  LEAD_TIME_BANDS,
  MTTR_BANDS,
  clamp,
  normalise,
} from './normalize';

export type { WeightOverrides } from './score';
export { scoreDimension, scoreHealth } from './score';

export { evidenceGaps, recommend } from './recommend';

export type {
  LevelAssessment,
  LevelDefinition,
  LevelNumber,
  LevelStatus,
  MaturityAssessment,
  Requirement,
  RequirementResult,
  RequirementStatus,
} from './maturity';
export { LEVELS, assessMaturity } from './maturity';

export type { AiReadinessAreaId, AiReadinessReport } from './aiReadiness';
export { AI_READINESS_AREAS, scoreAiReadiness } from './aiReadiness';

export type {
  CategoryResult,
  EvalCategory,
  EvalScore,
  EvaluationReport,
} from './evaluation';
export {
  CATEGORY_METRIC_IDS,
  METRIC_CATEGORIES,
  categorise,
  summariseEvaluation,
} from './evaluation';

export type {
  AiCostReport,
  CostBucket,
  CostRecommendation,
  ModelCost,
  TraceCost,
} from './aiCost';
export { costRecommendations, deriveWorkload, summariseAiCost } from './aiCost';
