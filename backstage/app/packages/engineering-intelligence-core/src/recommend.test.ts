// The failure this file prevents: recommending action on a metric nobody
// measured. "We collected nothing for PR cycle time" and "PR cycle time is bad"
// are different statements, and an executive report that conflates them invents
// a problem. Recommendations may only ever be derived from evidence that exists.

import { MetricSample } from './model';
import { evidenceGaps } from './recommend';
import { scoreHealth } from './score';

const OBSERVED = '2026-08-28T09:00:00.000Z';

function sample(
  metric: string,
  value: number,
  source = 'prometheus',
): MetricSample {
  return { metric, value, source, observedAt: OBSERVED };
}

/** Healthy on everything that is collectable. */
function healthySamples(): MetricSample[] {
  return [
    sample('catalog.ownershipCoverage', 1, 'catalog'),
    sample('catalog.goldenPathAdoption', 0.95, 'catalog'),
    sample('scorecard.goldTierRatio', 0.9, 'techInsights'),
    sample('dora.deployFrequencyPerDay', 3),
    sample('dora.leadTimeMinutes', 25),
    sample('scorecard.checksPassedRatio', 0.95, 'techInsights'),
    sample('test.flakinessRatio', 0.01),
    sample('test.passRate', 0.99),
    sample('dora.changeFailureRatePercent', 1),
    sample('dora.mttrMinutes', 20),
    sample('ai.governanceChecksRatio', 0.95, 'techInsights'),
    sample('ai.observabilityActive', 1, 'langfuse'),
    sample('ai.mcpToolSuccessRatio', 1),
    sample('security.scanningControlsRatio', 0.95, 'techInsights'),
    sample('finops.budgetUtilisationRatio', 0.7),
    sample('finops.costEfficiencyRatio', 0.95, 'opencost'),
  ];
}

describe('recommend', () => {
  it('produces nothing when every measured signal is above target', () => {
    const report = scoreHealth(healthySamples());
    expect(report.recommendations).toEqual([]);
  });

  it('never recommends action on a signal that was never measured', () => {
    // devEx is entirely uncollectable apart from lead time, and its three
    // missing signals all sit below any conceivable threshold — but there is no
    // observation behind them, so they must produce no recommendation at all.
    const report = scoreHealth(healthySamples());
    expect(report.recommendations.filter(r => r.dimension === 'devEx')).toEqual(
      [],
    );
  });

  it('attaches the triggering evidence to every recommendation', () => {
    const samples = healthySamples().filter(
      s => s.metric !== 'catalog.goldenPathAdoption',
    );
    samples.push(sample('catalog.goldenPathAdoption', 0.42, 'catalog'));

    const report = scoreHealth(samples);
    const rec = report.recommendations.find(
      r => r.id === 'platform.catalog.goldenPathAdoption',
    )!;

    expect(rec).toBeDefined();
    expect(rec.evidence).toHaveLength(1);
    expect(rec.evidence[0].metric).toBe('catalog.goldenPathAdoption');
    expect(rec.evidence[0].value).toBe(0.42);
    expect(rec.evidence[0].source).toBe('catalog');
    expect(rec.action).toMatch(/golden-path template/);
  });

  it('ranks critical first, then by how far below target the signal sits', () => {
    const samples = healthySamples()
      .filter(
        s =>
          ![
            'dora.changeFailureRatePercent',
            'catalog.ownershipCoverage',
            'catalog.goldenPathAdoption',
          ].includes(s.metric),
      )
      .concat([
        sample('dora.changeFailureRatePercent', 40), // critical
        sample('catalog.ownershipCoverage', 0.8, 'catalog'), // warning, mildly off
        sample('catalog.goldenPathAdoption', 0.1, 'catalog'), // warning, badly off
      ]);

    const report = scoreHealth(samples);
    const ids = report.recommendations.map(r => r.id);

    expect(ids[0]).toBe('reliability.dora.changeFailureRatePercent');
    expect(ids.indexOf('platform.catalog.goldenPathAdoption')).toBeLessThan(
      ids.indexOf('platform.catalog.ownershipCoverage'),
    );
  });

  it('still recommends from a real measurement inside an unscored dimension', () => {
    // Withholding a dimension score says "we cannot summarise this dimension",
    // not "we measured nothing in it". A 19% flakiness ratio is a real
    // observation and stays actionable even though the two sibling signals are
    // missing and the aggregate is suppressed. Dropping it would lose a genuine
    // finding to a rule about aggregation.
    const report = scoreHealth([sample('test.flakinessRatio', 0.19)]);

    expect(report.dimensions.quality.status).toBe('insufficient-evidence');
    expect(report.dimensions.quality.score).toBeNull();

    const rec = report.recommendations.find(
      r => r.id === 'quality.test.flakinessRatio',
    )!;
    expect(rec).toBeDefined();
    expect(rec.evidence[0].value).toBe(0.19);
    expect(rec.evidence[0].source).toBe('prometheus');
  });
});

describe('evidenceGaps', () => {
  it('reports unscored dimensions separately from recommendations', () => {
    const report = scoreHealth(healthySamples());
    const gaps = evidenceGaps(report.dimensions);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].dimension).toBe('devEx');
    expect(gaps[0].missing.sort()).toEqual([
      'devex.buildFailureRatio',
      'devex.ciDurationMinutes',
      'devex.prCycleTimeHours',
    ]);
    expect(gaps[0].expectedFrom).toEqual([
      'github (not yet collected — phase 5)',
    ]);
  });

  it('is empty when every dimension scored', () => {
    const report = scoreHealth(
      healthySamples().concat([
        sample('devex.prCycleTimeHours', 8, 'github'),
        sample('devex.ciDurationMinutes', 9, 'github'),
        sample('devex.buildFailureRatio', 0.03, 'github'),
      ]),
    );

    expect(evidenceGaps(report.dimensions)).toEqual([]);
    expect(report.status).toBe('ok');
    expect(report.dimensions.devEx.score).not.toBeNull();
  });
});
