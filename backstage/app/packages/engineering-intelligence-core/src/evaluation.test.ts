// The failure this file prevents: reading "we never tested for this" as "this is
// safe".
//
// A PII-safety category with no assertions must not become a 100% pass rate, and
// a metric no pattern recognises must not be silently dropped — that would let a
// team add an adversarial suite, have it categorised nowhere, and see a
// reassuring dashboard that never included it.

import {
  EvalScore,
  METRIC_CATEGORIES,
  categorise,
  summariseEvaluation,
} from './evaluation';

const OBSERVED = '2026-08-28T12:00:00.000Z';

function score(
  metric: string,
  passed?: boolean,
  value?: number,
  suite?: string,
): EvalScore {
  return { metric, passed, value, observedAt: OBSERVED, suite };
}

describe('categorise', () => {
  it('maps the DeepEval metrics this platform actually emits', () => {
    // conftest.py records `type(m).__name__`, so these are the literal strings
    // that reach Langfuse.
    expect(categorise('AnswerRelevancyMetric')).toBe('correctness');
    expect(categorise('FaithfulnessMetric')).toBe('hallucination');
    expect(categorise('ToolCorrectnessMetric')).toBe('correctness');
  });

  it('is about the risk, not the library', () => {
    // A future GroundednessCheck asks the same question as FaithfulnessMetric,
    // and a reader cares about "did it make something up", not which tool asked.
    expect(categorise('GroundednessCheck')).toBe('hallucination');
    expect(categorise('hallucination_rate')).toBe('hallucination');
  });

  it('prefers the specific risk over a generic word in the same name', () => {
    // Ordering in METRIC_CATEGORIES is load-bearing: without it a metric named
    // "PromptInjectionCorrectness" would land in correctness and a security
    // failure would be reported as an accuracy dip.
    expect(categorise('PromptInjectionCorrectness')).toBe('promptInjection');
    expect(categorise('PiiLeakageAccuracy')).toBe('piiSafety');
  });

  it('returns undefined for a metric nothing claims', () => {
    expect(categorise('SomeBrandNewThing')).toBeUndefined();
  });

  it('keeps every pattern mapped to a declared category', () => {
    for (const entry of METRIC_CATEGORIES) {
      expect(typeof entry.category).toBe('string');
      expect(entry.pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe('summariseEvaluation', () => {
  it('reports assertions, passes and failures', () => {
    const report = summariseEvaluation(
      [
        score('AnswerRelevancyMetric', true, 0.91),
        score('AnswerRelevancyMetric', false, 0.42),
        score('FaithfulnessMetric', true, 0.88),
      ],
      OBSERVED,
    );

    expect(report.assertions).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBeCloseTo(2 / 3);
  });

  it('omits a category nobody evaluated, rather than passing it by default', () => {
    // The whole point. A dashboard that showed PII safety at 100% because no PII
    // test exists would be worse than showing nothing.
    const report = summariseEvaluation(
      [score('AnswerRelevancyMetric', true, 0.9)],
      OBSERVED,
    );

    expect(report.categories.map(c => c.category)).toEqual(['correctness']);
    expect(
      report.categories.find(c => c.category === 'piiSafety'),
    ).toBeUndefined();
  });

  it('surfaces uncategorised metrics instead of dropping them', () => {
    // Silently discarding a result is how a team adds a suite, sees it counted
    // nowhere, and trusts a dashboard that never included it.
    const report = summariseEvaluation(
      [score('AnswerRelevancyMetric', true), score('WeirdCustomMetric', false)],
      OBSERVED,
    );

    expect(report.uncategorised).toEqual(['WeirdCustomMetric']);
    // ...and it still counts toward the overall verdict, because it was a real
    // assertion that really failed.
    expect(report.assertions).toBe(2);
    expect(report.failed).toBe(1);
  });

  it('separates a numeric value from a verdict', () => {
    // A metric can score 0.71 and pass or fail depending on its threshold, and
    // the threshold belongs to the harness. A value with no verdict contributes
    // to the mean but not the pass rate.
    const report = summariseEvaluation(
      [
        score('FaithfulnessMetric', undefined, 0.8),
        score('FaithfulnessMetric', true, 0.9),
      ],
      OBSERVED,
    );

    const hallucination = report.categories.find(
      c => c.category === 'hallucination',
    )!;
    expect(hallucination.assertions).toBe(1);
    expect(hallucination.passRate).toBe(1);
    expect(hallucination.meanScore).toBeCloseTo(0.85);
  });

  it('reports a null pass rate for a category with values but no verdicts', () => {
    const report = summariseEvaluation(
      [score('FaithfulnessMetric', undefined, 0.8)],
      OBSERVED,
    );
    const hallucination = report.categories.find(
      c => c.category === 'hallucination',
    )!;
    expect(hallucination.passRate).toBeNull();
    expect(hallucination.meanScore).toBeCloseTo(0.8);
  });

  it('lists the raw metrics behind each category', () => {
    // So a reader can tell which tool produced a number without leaving the page.
    const report = summariseEvaluation(
      [
        score('AnswerRelevancyMetric', true),
        score('ToolCorrectnessMetric', true),
      ],
      OBSERVED,
    );
    expect(report.categories[0].metrics).toEqual([
      'AnswerRelevancyMetric',
      'ToolCorrectnessMetric',
    ]);
  });

  it('ranks suites worst-first', () => {
    const report = summariseEvaluation(
      [
        score('AnswerRelevancyMetric', true, 1, 'good-suite'),
        score('AnswerRelevancyMetric', true, 1, 'good-suite'),
        score('AnswerRelevancyMetric', false, 0, 'bad-suite'),
        score('AnswerRelevancyMetric', true, 1, 'bad-suite'),
      ],
      OBSERVED,
    );

    expect(report.suites.map(s => s.suite)).toEqual([
      'bad-suite',
      'good-suite',
    ]);
    expect(report.suites[0].passRate).toBe(0.5);
  });

  it('is empty and null, not zero, when nothing was evaluated', () => {
    const report = summariseEvaluation([], OBSERVED);
    expect(report.assertions).toBe(0);
    expect(report.passRate).toBeNull();
    expect(report.categories).toEqual([]);
    expect(report.suites).toEqual([]);
  });
});
