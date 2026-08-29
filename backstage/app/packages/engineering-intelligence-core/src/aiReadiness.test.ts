// The failure this file prevents: an AI readiness score that looks respectable
// because the hard parts were left out of the average.
//
// Five of the twelve areas have no collector — security, privacy, architecture,
// testing, cost and incident management are the ones an organisation actually
// struggles with. If unscored areas were counted as zero the score would be
// meaningless; if they were silently dropped from the *denominator* without
// being reported, a platform that had only wired up observability could claim
// high readiness. They are excluded from the mean and reported as gaps.

import {
  AI_READINESS_AREAS,
  AiReadinessAreaId,
  scoreAiReadiness,
} from './aiReadiness';
import { MetricSample } from './model';

const OBSERVED = '2026-08-28T12:00:00.000Z';

function sample(
  metric: string,
  value: number,
  source = 'techInsights',
): MetricSample {
  return { metric, value, source, observedAt: OBSERVED };
}

/** Everything that has a collector today, all healthy. */
function collectableSamples(): MetricSample[] {
  return [
    sample('ai.modelCardRatio', 0.9),
    sample('ai.evalSuiteRatio', 0.8),
    sample('ai.observabilityWiredRatio', 0.85),
    sample('ai.observabilityActive', 1, 'langfuse'),
    sample('ai.modelVersionedRatio', 1, 'mlflow'),
    sample('ai.promptsManagedRatio', 0.75, 'langfuse'),
    sample('ai.mcpToolSuccessRatio', 0.99, 'prometheus'),
  ];
}

describe('AI_READINESS_AREAS', () => {
  it('covers the twelve readiness areas', () => {
    expect(AI_READINESS_AREAS).toHaveLength(12);
  });

  it('declares the areas nothing collects, rather than omitting them', () => {
    // A readiness model built only from the measurable half would flatter an
    // organisation that has done none of the hard parts.
    //
    // Phase 7 gave security, privacy and testing a source — an adversarial, PII
    // or regression eval suite — and phase 8 gave cost one. Only these two now
    // have no collector at all, and architecture never will.
    const undeclared: AiReadinessAreaId[] = ['architecture', 'incidentManagement'];
    for (const id of undeclared) {
      const area = AI_READINESS_AREAS.find(a => a.id === id)!;
      expect(area).toBeDefined();
      for (const signal of area.signals) {
        expect(signal.expectedFrom).toMatch(/not collected/);
      }
    }
  });

  it('points the eval-backed areas at evaluation results, not a future phase', () => {
    // Phase 7's payoff: prompt injection, PII leakage and regression stop being
    // "not collected" and become "run the suite". They still report insufficient
    // evidence for an organisation that has not run one — an untested risk is
    // unknown, not absent — but the gap now names an action.
    const byId = Object.fromEntries(AI_READINESS_AREAS.map(a => [a.id, a]));
    expect(byId.security.signals[0].expectedFrom).toMatch(/langfuse-scores/);
    expect(byId.security.signals[0].expectedFrom).toMatch(/adversarial/);
    expect(byId.privacy.signals[0].expectedFrom).toMatch(/PII eval suite/);
    expect(byId.testing.signals[0].expectedFrom).toMatch(/regression evals/);
  });

  it('names what each still-uncollected area is waiting on', () => {
    // "Not measurable" is a dead end; naming the reason makes it a plan.
    // Architecture deliberately says it needs human review rather than pointing
    // at a future phase, because no metric will ever answer it.
    const byId = Object.fromEntries(AI_READINESS_AREAS.map(a => [a.id, a]));
    expect(byId.architecture.signals[0].expectedFrom).toMatch(/human review/);
    expect(byId.incidentManagement.signals[0].expectedFrom).toMatch(
      /no AI classification/,
    );
  });

  it('scores cost from attribution, caveated as convention-based', () => {
    // Phase 8. The join is trace name → catalog entity, which works and is
    // fragile, so the caveat travels onto every evidence row rather than living
    // only in a doc.
    const byId = Object.fromEntries(AI_READINESS_AREAS.map(a => [a.id, a]));
    const signal = byId.cost.signals[0];
    expect(signal.expectedFrom).toBe('ai-cost');
    expect(signal.caveat).toMatch(/never redistributed/i);
  });

  it('scores evaluation from results, with presence as the weaker fallback', () => {
    // Before phase 7 this area could only say a suite existed. Results now carry
    // the majority of its weight, because a declared suite that fails is worse
    // than no suite: it looks like coverage.
    const evaluation = AI_READINESS_AREAS.find(a => a.id === 'evaluation')!;
    const results = evaluation.signals.find(
      s => s.metric === 'ai.evalPassRatio',
    )!;
    const presence = evaluation.signals.find(
      s => s.metric === 'ai.evalSuiteRatio',
    )!;

    expect(results.weight).toBeGreaterThan(presence.weight);
    // The caveat now sits on the presence signal alone, so an area scored from
    // real results is no longer labelled presence-only.
    expect(presence.caveat).toMatch(/not results/i);
    expect(results.caveat).toBeUndefined();
  });

  it('still scores evaluation when only suite presence is known', () => {
    // The common case: push_to_langfuse.py only reaches a publicly reachable
    // Langfuse, so most installs have suites and no results. Presence is weak
    // evidence, not absent evidence — the area must not go dark.
    const report = scoreAiReadiness(
      [sample('ai.evalSuiteRatio', 0.8)],
      OBSERVED,
    );
    expect(report.areas.evaluation.score).not.toBeNull();
    expect(report.areas.evaluation.status).toBe('partial');
  });

  it('lets real results dominate the evaluation score', () => {
    const presenceOnly = scoreAiReadiness(
      [sample('ai.evalSuiteRatio', 1)],
      OBSERVED,
    );
    const failingResults = scoreAiReadiness(
      [
        sample('ai.evalSuiteRatio', 1),
        sample('ai.evalPassRatio', 0.2, 'langfuse-scores'),
      ],
      OBSERVED,
    );

    // A platform whose suites all exist but mostly fail must score worse than
    // one where we simply have not seen the results.
    expect(failingResults.areas.evaluation.score!).toBeLessThan(
      presenceOnly.areas.evaluation.score!,
    );
  });
});

describe('scoreAiReadiness', () => {
  it('scores the six areas that have collectors and withholds the rest', () => {
    const report = scoreAiReadiness(collectableSamples(), OBSERVED);

    expect(report.measurable).toBe(6);
    expect(report.total).toBe(12);
    expect(report.status).toBe('partial');

    for (const id of [
      'governance',
      'evaluation',
      'observability',
      'modelManagement',
      'promptManagement',
      'reliability',
    ] as AiReadinessAreaId[]) {
      expect(report.areas[id].score).not.toBeNull();
    }
    for (const id of [
      'security',
      'privacy',
      'architecture',
      'testing',
      'cost',
      'incidentManagement',
    ] as AiReadinessAreaId[]) {
      expect(report.areas[id].score).toBeNull();
      expect(report.areas[id].status).toBe('insufficient-evidence');
    }
  });

  it('excludes unscored areas from the mean rather than counting them as zero', () => {
    const report = scoreAiReadiness(collectableSamples(), OBSERVED);
    const scored = Object.values(report.areas).filter(a => a.score !== null);
    const mean =
      scored.reduce((t, a) => t + (a.score as number), 0) / scored.length;

    expect(report.overallScore).toBeCloseTo(mean, 1);
    // Zeroing the six uncollectable areas would halve this and peg every
    // organisation below 50 regardless of what it had actually done.
    expect(report.overallScore!).toBeGreaterThan(50);
  });

  it('separates the three governance facts instead of blending them', () => {
    // The Engineering Health model uses one blended ai.governanceChecksRatio.
    // Readiness needs them apart: a model card, an eval suite and wired
    // observability are three different kinds of maturity, and averaging them
    // hides which one is missing.
    const report = scoreAiReadiness(
      [
        sample('ai.modelCardRatio', 1),
        sample('ai.evalSuiteRatio', 0),
        sample('ai.observabilityWiredRatio', 1),
      ],
      OBSERVED,
    );

    expect(report.areas.governance.score).toBe(100);
    expect(report.areas.evaluation.score).toBe(0);
  });

  it('reports insufficient evidence overall when nothing was collected', () => {
    const report = scoreAiReadiness([], OBSERVED);
    expect(report.overallScore).toBeNull();
    expect(report.status).toBe('insufficient-evidence');
    expect(report.measurable).toBe(0);
  });

  it('carries evidence with a source on every scored area', () => {
    const report = scoreAiReadiness(collectableSamples(), OBSERVED);
    for (const area of Object.values(report.areas)) {
      if (area.score === null) continue;
      expect(area.evidence.length).toBeGreaterThan(0);
      for (const row of area.evidence) {
        expect(row.source).toBeTruthy();
      }
    }
  });

  it('reuses the shared engine, so impacts still sum to each score', () => {
    // The reason the scoring functions are generic over their area id: one
    // implementation of normalisation, coverage and evidence, two models.
    const report = scoreAiReadiness(collectableSamples(), OBSERVED);
    for (const area of Object.values(report.areas)) {
      if (area.score === null) continue;
      const summed = area.evidence.reduce((t, e) => t + e.impact, 0);
      expect(summed).toBeCloseTo(area.score, 0);
    }
  });

  it('stamps the generation time it is given', () => {
    expect(scoreAiReadiness([], OBSERVED).generatedAt).toBe(OBSERVED);
  });
});
