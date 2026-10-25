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

export type {
  AdvisorAnswer,
  AdvisorContext,
  AdvisorQuestion,
  Change,
  DimensionChange,
  SnapshotSummary,
} from './advisor';
export type {
  BenchmarkProvider,
  BenchmarkResult,
  BenchmarkSubmission,
  Percentile,
} from './benchmark';
export {
  MIN_COHORT_SIZE,
  NO_BENCHMARK_PROVIDER,
  placeOrWithhold,
  toSubmission,
} from './benchmark';

export type { Organisation, OrganisationRecord, TenantScope } from './tenancy';
export {
  DEFAULT_ORGANISATION,
  defaultScope,
  isSingleTenant,
  scopeFrom,
  scopeKey,
} from './tenancy';

export {
  answer,
  buildAdvisorContext,
  citableMetrics,
  dimensionChanges,
  overallChange,
  unsupportedCitations,
} from './advisor';

export type {
  DriverId,
  PerceptionId,
  Statement,
  SurveyAggregate,
  SurveyAnswers,
  TimeBucket,
} from './devexSurvey';
export {
  DRIVERS,
  LIKERT_MAX,
  LIKERT_MIN,
  MIN_RESPONSES,
  PERCEPTIONS,
  TIME_BUCKETS,
  aggregateSurvey,
  likertToScore,
  validateAnswers,
} from './devexSurvey';

export type {
  Core4Area,
  Core4AreaConfig,
  Core4AreaId,
  Core4Change,
  Core4Report,
  Core4TeamInput,
  Core4TeamRow,
  NotMeasured,
} from './core4';
export {
  CORE4_AREAS,
  CORE4_AREA_IDS,
  CORE4_GUARDRAIL,
  core4Changes,
  core4TeamRows,
  scoreCore4,
} from './core4';
