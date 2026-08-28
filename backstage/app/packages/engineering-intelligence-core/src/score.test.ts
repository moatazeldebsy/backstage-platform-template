// The contract this file defends: an Engineering Health score is never asserted
// without evidence, and never invented when evidence is absent.
//
// Every dashboard page in extensions.tsx substitutes plausible demo data when
// its source is unreachable (DORA_DEMO, DEMO_LANGFUSE_*). That is fine for a
// per-service tab and dangerous for an organisation-wide health score, which is
// exactly the kind of number that ends up on a slide. These tests assert the
// opposite behaviour: a missing source lowers coverage and, past a threshold,
// withholds the score entirely.

import { DIMENSIONS, dimensionConfig } from './dimensions';
import { MetricSample } from './model';
import { scoreDimension, scoreHealth } from './score';

const OBSERVED = '2026-08-28T09:00:00.000Z';

function sample(
  metric: string,
  value: number,
  source = 'prometheus',
  observedAt = OBSERVED,
): MetricSample {
  return { metric, value, source, observedAt };
}

/** Samples that let every dimension except devEx score. */
function fullyCollectableSamples(): MetricSample[] {
  return [
    sample('catalog.ownershipCoverage', 0.95, 'catalog'),
    sample('catalog.goldenPathAdoption', 0.74, 'catalog'),
    sample('scorecard.goldTierRatio', 0.4, 'techInsights'),
    sample('scaffolder.taskSuccessRatio', 0.95, 'scaffolder'),
    sample('dora.deployFrequencyPerDay', 2),
    sample('dora.leadTimeMinutes', 30),
    sample('scorecard.checksPassedRatio', 0.8, 'techInsights'),
    sample('test.flakinessRatio', 0.03),
    sample('test.passRate', 0.97),
    sample('dora.changeFailureRatePercent', 4),
    sample('dora.mttrMinutes', 40),
    sample('ai.governanceChecksRatio', 0.5, 'techInsights'),
    sample('ai.observabilityActive', 1, 'langfuse'),
    sample('ai.mcpToolSuccessRatio', 0.99),
    sample('security.scanningControlsRatio', 0.6, 'techInsights'),
    sample('finops.budgetUtilisationRatio', 0.85),
    sample('finops.costEfficiencyRatio', 0.7, 'opencost'),
  ];
}

describe('scoreDimension', () => {
  const reliability = dimensionConfig('reliability');

  it('scores ok when every signal has a sample', () => {
    const result = scoreDimension(reliability, [
      sample('dora.changeFailureRatePercent', 4),
      sample('dora.mttrMinutes', 40),
    ]);

    expect(result.status).toBe('ok');
    expect(result.coverage).toBe(1);
    expect(result.score).toBe(100);
    expect(result.missing).toEqual([]);
  });

  it('reports partial and names the missing source when a signal has no sample', () => {
    const result = scoreDimension(reliability, [
      sample('dora.changeFailureRatePercent', 4),
    ]);

    expect(result.status).toBe('partial');
    expect(result.coverage).toBe(0.5);
    expect(result.missing).toEqual([
      {
        metric: 'dora.mttrMinutes',
        expectedFrom: 'prometheus',
        reason: 'No sample was collected for dora.mttrMinutes.',
      },
    ]);
  });

  it('does not drag the score toward zero for a missing signal', () => {
    // A signal that was not measured is not a signal that scored badly. With one
    // of two perfect signals present the score stays 100, and only coverage
    // falls — treating absence as a zero would have produced 50 here and quietly
    // punished every service the exporter has not reached yet.
    const result = scoreDimension(reliability, [
      sample('dora.changeFailureRatePercent', 4),
    ]);
    expect(result.score).toBe(100);
  });

  it('withholds the score entirely below minCoverage', () => {
    const quality = dimensionConfig('quality');
    // One 0.3-weight signal out of 1.0 total = 0.3 coverage, under the 0.5 bar.
    const result = scoreDimension(quality, [sample('test.passRate', 0.97)]);

    expect(result.status).toBe('insufficient-evidence');
    expect(result.score).toBeNull();
    expect(result.coverage).toBe(0.3);
  });

  it('still returns what it did measure when the score is withheld', () => {
    // The reader should be able to see the gap, not merely be told there is one.
    const quality = dimensionConfig('quality');
    const result = scoreDimension(quality, [sample('test.passRate', 0.97)]);

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].metric).toBe('test.passRate');
    // ...but that evidence contributes nothing, because nothing was scored.
    expect(result.evidence[0].impact).toBe(0);
    expect(result.missing.map(m => m.metric).sort()).toEqual([
      'scorecard.checksPassedRatio',
      'test.flakinessRatio',
    ]);
  });

  it('returns insufficient-evidence, not a zero, when nothing was collected', () => {
    const result = scoreDimension(reliability, []);
    expect(result.score).toBeNull();
    expect(result.status).toBe('insufficient-evidence');
    expect(result.coverage).toBe(0);
    expect(result.evidence).toEqual([]);
  });

  it('ignores samples belonging to other dimensions', () => {
    const result = scoreDimension(reliability, [
      sample('finops.costEfficiencyRatio', 0.9, 'opencost'),
    ]);
    expect(result.status).toBe('insufficient-evidence');
    expect(result.evidence).toEqual([]);
  });

  it('prefers the most recently observed sample when a metric repeats', () => {
    const result = scoreDimension(reliability, [
      sample('dora.changeFailureRatePercent', 40, 'prometheus', OBSERVED),
      sample(
        'dora.changeFailureRatePercent',
        2,
        'prometheus',
        '2026-08-28T11:00:00.000Z',
      ),
      sample('dora.mttrMinutes', 40),
    ]);
    expect(
      result.evidence.find(e => e.metric === 'dora.changeFailureRatePercent')!
        .value,
    ).toBe(2);
  });
});

describe('evidence', () => {
  it('carries a source and a timestamp on every row', () => {
    // A score whose evidence cannot be traced back to a source and a moment is
    // an assertion, not a measurement.
    const report = scoreHealth(fullyCollectableSamples());
    const rows = Object.values(report.dimensions).flatMap(d => d.evidence);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBeTruthy();
      expect(Number.isNaN(Date.parse(row.observedAt))).toBe(false);
    }
  });

  it('has impacts that sum to the dimension score', () => {
    // This is what makes a score explainable rather than asserted: the reader
    // can add the evidence up and land on the headline number.
    const report = scoreHealth(fullyCollectableSamples());

    for (const dimension of Object.values(report.dimensions)) {
      if (dimension.score === null) continue;
      const summed = dimension.evidence.reduce((t, e) => t + e.impact, 0);
      expect(summed).toBeCloseTo(dimension.score, 0);
    }
  });

  it('propagates a signal caveat onto its evidence', () => {
    // The security dimension observes whether a scanner is declared, not what it
    // found. Losing that caveat would turn "controls are wired up" into
    // "we are secure".
    const report = scoreHealth(fullyCollectableSamples());
    const row = report.dimensions.security.evidence.find(
      e => e.metric === 'security.scanningControlsRatio',
    )!;
    expect(row.caveat).toMatch(/Control presence, not finding count/);
  });
});

describe('scoreHealth', () => {
  it('leaves Developer Experience unscored while no collector supplies it', () => {
    // Only deployment lead time is collectable today; PR cycle time, CI duration
    // and build failure rate have no source anywhere in the platform. The
    // dimension must say so rather than score 100 on its one available signal.
    const report = scoreHealth(fullyCollectableSamples());

    expect(report.dimensions.devEx.score).toBeNull();
    expect(report.dimensions.devEx.status).toBe('insufficient-evidence');
    expect(report.dimensions.devEx.missing.map(m => m.metric).sort()).toEqual([
      'devex.buildFailureRatio',
      'devex.ciDurationMinutes',
      'devex.prCycleTimeHours',
    ]);
  });

  it('excludes unscored dimensions from the overall score rather than zeroing them', () => {
    // Counting devEx as a zero would understate overall health by roughly
    // fourteen points, and would keep doing so until phase 5 lands.
    const report = scoreHealth(fullyCollectableSamples());
    const scored = Object.values(report.dimensions).filter(
      d => d.score !== null,
    );
    const mean =
      scored.reduce((t, d) => t + (d.score as number), 0) / scored.length;

    expect(report.overallScore).toBeCloseTo(mean, 1);
    expect(report.status).toBe('partial');
  });

  it('returns a null overall score when nothing at all could be collected', () => {
    const report = scoreHealth([]);
    expect(report.overallScore).toBeNull();
    expect(report.status).toBe('insufficient-evidence');
    expect(report.recommendations).toEqual([]);
  });

  it('honours per-dimension weight overrides', () => {
    const samples = fullyCollectableSamples();
    const flat = scoreHealth(samples);
    const weighted = scoreHealth(samples, { weights: { finops: 20 } });

    expect(weighted.overallScore).not.toBe(flat.overallScore);
    // Weighting FinOps twentyfold should pull the total toward the FinOps score.
    const finops = flat.dimensions.finops.score as number;
    expect(Math.abs((weighted.overallScore as number) - finops)).toBeLessThan(
      Math.abs((flat.overallScore as number) - finops),
    );
  });

  it('reports every declared dimension, scored or not', () => {
    const report = scoreHealth([]);
    expect(Object.keys(report.dimensions).sort()).toEqual(
      DIMENSIONS.map(d => d.id).sort(),
    );
  });

  it('stamps the generation time it was given', () => {
    const report = scoreHealth([], { generatedAt: OBSERVED });
    expect(report.generatedAt).toBe(OBSERVED);
  });
});
