// The evaluation model — phase 7.
//
// Phase 6 could only observe that an evaluation suite *existed*. A service whose
// evals all failed scored identically to one whose evals all passed, and the
// signal carried a caveat saying so. This turns "a suite exists" into "here is
// what it found".
//
// It is an abstraction, not a testing platform. Nothing here runs an evaluation
// or defines what a good one looks like — it reads results some harness already
// produced and organises them into categories a reader can act on. DeepEval is
// the only producer today; the mapping below is the single place a second one
// gets taught.

/**
 * What an evaluation is actually testing.
 *
 * Deliberately about the *risk*, not the tool. `FaithfulnessMetric` and a future
 * `GroundednessCheck` both answer "did it make something up", and a reader
 * cares about that question rather than which library asked it.
 */
export type EvalCategory =
  | 'correctness'
  | 'hallucination'
  | 'policyCompliance'
  | 'piiSafety'
  | 'promptInjection'
  | 'bias'
  | 'regression'
  | 'latency'
  | 'cost';

/**
 * Metric name → category. **This is the extension point.**
 *
 * A new evaluation library is added by appending patterns here, and nothing else
 * changes: the collector, the scoring signals and the dashboard all work off
 * categories. Patterns are matched case-insensitively against the raw metric
 * name, most specific first.
 *
 * The names on the left are DeepEval class names, because that is what
 * test-suites/test-deepeval/tests/conftest.py records — it writes
 * `type(m).__name__` into metrics.jsonl, and push_to_langfuse.py uses that
 * verbatim as the Langfuse score name.
 */
export const METRIC_CATEGORIES: { pattern: RegExp; category: EvalCategory }[] =
  [
    // Specific risks first — several of these also contain generic words.
    { pattern: /injection|jailbreak/i, category: 'promptInjection' },
    { pattern: /pii|privacy|leak/i, category: 'piiSafety' },
    { pattern: /bias|fairness/i, category: 'bias' },
    { pattern: /toxic|policy|moderation|harm/i, category: 'policyCompliance' },
    { pattern: /faithful|hallucinat|grounded/i, category: 'hallucination' },
    { pattern: /regression/i, category: 'regression' },
    { pattern: /latency|duration/i, category: 'latency' },
    { pattern: /cost|token/i, category: 'cost' },
    // Generic last, so `ToolCorrectnessMetric` does not swallow a more specific
    // match and `AnswerRelevancyMetric` still lands somewhere sensible.
    { pattern: /correct|relevanc|accuracy|answer/i, category: 'correctness' },
  ];

/** The category a metric belongs to, or undefined when nothing claims it. */
export function categorise(metric: string): EvalCategory | undefined {
  return METRIC_CATEGORIES.find(m => m.pattern.test(metric))?.category;
}

/** One score, as produced by an evaluation harness. */
export interface EvalScore {
  /** Raw metric name, e.g. `FaithfulnessMetric`. */
  metric: string;
  /** The numeric value, where the harness reported one. */
  value?: number;
  /** Whether the assertion passed. Separate from `value`: a metric can score
   *  0.71 and still pass or fail depending on its threshold, and the threshold
   *  belongs to the harness, not here. */
  passed?: boolean;
  observedAt: string;
  /** Optional suite or test name, for the per-suite breakdown. */
  suite?: string;
}

export interface CategoryResult {
  category: EvalCategory;
  /** Raw metric names that rolled up into this category. */
  metrics: string[];
  assertions: number;
  passed: number;
  /** Pass rate, or null when no metric in this category reported pass/fail. */
  passRate: number | null;
  /** Mean numeric value, or null when no metric reported one. */
  meanScore: number | null;
}

export interface EvaluationReport {
  generatedAt: string;
  /** Total assertions with a pass/fail verdict. */
  assertions: number;
  passed: number;
  failed: number;
  /** Overall pass rate, or null when nothing reported a verdict. */
  passRate: number | null;
  categories: CategoryResult[];
  /** Metric names no pattern claimed — surfaced so the mapping can be extended
   *  rather than silently dropping results nobody notices are missing. */
  uncategorised: string[];
  /** Per-suite pass rates, where the harness named a suite. */
  suites: {
    suite: string;
    assertions: number;
    passed: number;
    passRate: number;
  }[];
}

function round(value: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Roll raw scores up into categories. Pure, so the whole model is testable
 * without Langfuse.
 *
 * Assertions without a verdict still contribute their numeric value to
 * `meanScore` but not to the pass rate — a metric that recorded 0.82 and no
 * pass/fail is a measurement, not a judgement, and counting it as a pass would
 * invent one.
 */
export function summariseEvaluation(
  scores: EvalScore[],
  generatedAt: string = new Date().toISOString(),
): EvaluationReport {
  const byCategory = new Map<EvalCategory, EvalScore[]>();
  const uncategorised = new Set<string>();

  for (const score of scores) {
    const category = categorise(score.metric);
    if (!category) {
      uncategorised.add(score.metric);
      continue;
    }
    const bucket = byCategory.get(category) ?? [];
    bucket.push(score);
    byCategory.set(category, bucket);
  }

  const categories: CategoryResult[] = [];
  for (const [category, bucket] of byCategory) {
    const verdicts = bucket.filter(s => s.passed !== undefined);
    const values = bucket
      .map(s => s.value)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    categories.push({
      category,
      metrics: [...new Set(bucket.map(s => s.metric))].sort(),
      assertions: verdicts.length,
      passed: verdicts.filter(s => s.passed).length,
      passRate: verdicts.length
        ? round(verdicts.filter(s => s.passed).length / verdicts.length)
        : null,
      meanScore: values.length
        ? round(values.reduce((a, b) => a + b, 0) / values.length)
        : null,
    });
  }
  categories.sort((a, b) => a.category.localeCompare(b.category));

  const allVerdicts = scores.filter(s => s.passed !== undefined);
  const passed = allVerdicts.filter(s => s.passed).length;

  const bySuite = new Map<string, { assertions: number; passed: number }>();
  for (const score of allVerdicts) {
    if (!score.suite) continue;
    const row = bySuite.get(score.suite) ?? { assertions: 0, passed: 0 };
    row.assertions += 1;
    if (score.passed) row.passed += 1;
    bySuite.set(score.suite, row);
  }

  return {
    generatedAt,
    assertions: allVerdicts.length,
    passed,
    failed: allVerdicts.length - passed,
    passRate: allVerdicts.length ? round(passed / allVerdicts.length) : null,
    categories,
    uncategorised: [...uncategorised].sort(),
    suites: [...bySuite.entries()]
      .map(([suite, row]) => ({
        suite,
        assertions: row.assertions,
        passed: row.passed,
        passRate: round(row.passed / row.assertions),
      }))
      .sort((a, b) => a.passRate - b.passRate),
  };
}

/**
 * The metric ids the evaluation report contributes to the scoring models.
 *
 * Only categories that actually reported a verdict produce a sample. A category
 * nobody evaluated stays absent, so the AI readiness areas it feeds report
 * insufficient evidence rather than scoring zero — an untested risk is unknown,
 * not safe. That distinction is the whole reason this layer exists.
 */
export const CATEGORY_METRIC_IDS: Partial<Record<EvalCategory, string>> = {
  correctness: 'ai.evalCorrectnessRatio',
  hallucination: 'ai.evalHallucinationFreeRatio',
  policyCompliance: 'ai.evalPolicyComplianceRatio',
  piiSafety: 'ai.evalPiiSafetyRatio',
  promptInjection: 'ai.evalPromptInjectionRatio',
  bias: 'ai.evalBiasFreeRatio',
  regression: 'ai.evalRegressionRatio',
};
