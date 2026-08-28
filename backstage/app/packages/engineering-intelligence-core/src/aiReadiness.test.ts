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
    const undeclared: AiReadinessAreaId[] = [
      'security',
      'privacy',
      'architecture',
      'testing',
      'cost',
      'incidentManagement',
    ];
    for (const id of undeclared) {
      const area = AI_READINESS_AREAS.find(a => a.id === id)!;
      expect(area).toBeDefined();
      for (const signal of area.signals) {
        expect(signal.expectedFrom).toMatch(/not collected/);
      }
    }
  });

  it('names what each uncollected area is waiting on', () => {
    // "Not measurable" is a dead end; naming the phase or the reason makes it a
    // plan. Architecture deliberately says it needs human review rather than
    // pointing at a future phase, because no metric will ever answer it.
    const byId = Object.fromEntries(AI_READINESS_AREAS.map(a => [a.id, a]));
    expect(byId.cost.signals[0].expectedFrom).toMatch(/phase 8/);
    expect(byId.privacy.signals[0].expectedFrom).toMatch(/phase 7/);
    expect(byId.architecture.signals[0].expectedFrom).toMatch(/human review/);
  });

  it('caveats the evaluation signal as presence, not results', () => {
    // A service whose evals all fail scores identically to one whose evals all
    // pass. Losing that caveat would turn "a suite exists" into "it works".
    const evaluation = AI_READINESS_AREAS.find(a => a.id === 'evaluation')!;
    expect(evaluation.signals[0].caveat).toMatch(/not results/i);
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
