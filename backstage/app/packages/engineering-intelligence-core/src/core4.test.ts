// The failures this file prevents: a Core 4 view that drifts from the health
// model's own DORA bands, a key metric that silently disappears, and a team
// breakdown that shows one or two people's numbers as a "team" figure.

import {
  CORE4_AREAS,
  CORE4_AREA_IDS,
  core4Changes,
  core4TeamRows,
  scoreCore4,
} from './core4';
import { DIMENSIONS } from './dimensions';
import { aggregateSurvey, DRIVERS, PERCEPTIONS, SurveyAnswers } from './devexSurvey';
import { MetricSample } from './model';

const OBSERVED = '2026-10-17T12:00:00.000Z';

function sample(metric: string, value: number, source = 'prometheus'): MetricSample {
  return { metric, value, source, observedAt: OBSERVED };
}

function allSamples(): MetricSample[] {
  return [
    sample('core4.diffsPerEngineerWeekly', 3),
    sample('dora.leadTimeMinutes', 90),
    sample('dora.deployFrequencyPerDay', 2),
    sample('survey.perceivedDeliveryRate', 60, 'devex-survey'),
    sample('survey.dxi', 70, 'devex-survey'),
    sample('survey.easeOfDelivery', 65, 'devex-survey'),
    sample('dora.changeFailureRatePercent', 8),
    sample('dora.mttrMinutes', 45),
    sample('survey.perceivedQuality', 75, 'devex-survey'),
    sample('security.scanningControlsRatio', 0.9, 'techInsights'),
    sample('survey.newCapabilitiesRatio', 0.45, 'devex-survey'),
  ];
}

function surveyOf(n: number, score: number, newCapabilities: number) {
  const a: SurveyAnswers = {
    drivers: Object.fromEntries(DRIVERS.map(d => [d.id, score])) as SurveyAnswers['drivers'],
    perceptions: Object.fromEntries(PERCEPTIONS.map(p => [p.id, score])) as SurveyAnswers['perceptions'],
    time: { newCapabilities, maintenance: 100 - newCapabilities, toil: 0, other: 0 },
  };
  return aggregateSurvey(Array(n).fill(a));
}

describe('CORE4_AREAS', () => {
  it('declares the four areas, each with its key metric among its signals', () => {
    expect(CORE4_AREAS.map(a => a.id)).toEqual(CORE4_AREA_IDS);
    for (const area of CORE4_AREAS) {
      expect(area.signals.map(s => s.metric)).toContain(area.keyMetric);
    }
  });

  it('reuses the health model normalisers rather than redeclaring them', () => {
    const health = new Map(DIMENSIONS.flatMap(d => d.signals).map(s => [s.metric, s]));
    const shared = CORE4_AREAS.flatMap(a => a.signals).filter(s => health.has(s.metric));
    expect(shared.length).toBeGreaterThan(0);
    for (const signal of shared) {
      expect(signal.normaliser).toBe(health.get(signal.metric)!.normaliser);
    }
  });

  it('carries the anti-target caveat on diffs per engineer', () => {
    const speed = CORE4_AREAS.find(a => a.id === 'speed')!;
    const diffs = speed.signals.find(s => s.metric === speed.keyMetric)!;
    expect(diffs.caveat).toMatch(/never per person/);
  });
});

describe('scoreCore4', () => {
  it('scores every area and surfaces each key metric raw', () => {
    const report = scoreCore4(allSamples(), { generatedAt: OBSERVED });
    for (const id of CORE4_AREA_IDS) {
      expect(report.areas[id].score).not.toBeNull();
      expect(report.areas[id].key).not.toBeNull();
    }
    expect(report.areas.speed.key!.value).toBe(3);
    expect(report.areas.impact.key!.value).toBe(0.45);
  });

  it('reports insufficient evidence, not zero, before the first survey', () => {
    const systemOnly = allSamples().filter(s => s.source !== 'devex-survey');
    const report = scoreCore4(systemOnly);
    expect(report.areas.effectiveness.score).toBeNull();
    expect(report.areas.effectiveness.status).toBe('insufficient-evidence');
    expect(report.areas.impact.score).toBeNull();
    // System metrics alone still carry Speed and Quality.
    expect(report.areas.speed.score).not.toBeNull();
    expect(report.areas.quality.score).not.toBeNull();
  });

  it('lists what no platform can measure instead of omitting it', () => {
    const report = scoreCore4([]);
    const labels = report.areas.effectiveness.notMeasured.map(n => n.label);
    expect(labels).toContain('Regrettable attrition');
    expect(report.areas.impact.notMeasured.length).toBeGreaterThan(0);
  });

  it('has no overall score to roll the four areas into', () => {
    expect(scoreCore4(allSamples())).not.toHaveProperty('overallScore');
  });
});

describe('core4TeamRows', () => {
  it('divides throughput by headcount at or above the floor', () => {
    const [row] = core4TeamRows([
      { team: 'payments', engineers: 6, mergedPrsWeekly: 15, survey: surveyOf(5, 4, 50) },
    ]);
    expect(row).toEqual({
      team: 'payments',
      engineers: 6,
      diffsPerEngineerWeekly: 2.5,
      responses: 5,
      dxi: 75,
      newCapabilitiesRatio: 0.5,
      withheld: false,
    });
  });

  it('withholds per-engineer throughput and survey results for small groups', () => {
    const [row] = core4TeamRows([
      { team: 'tiny', engineers: 2, mergedPrsWeekly: 9, survey: surveyOf(2, 5, 80) },
    ]);
    expect(row.diffsPerEngineerWeekly).toBeNull();
    expect(row.dxi).toBeNull();
    expect(row.newCapabilitiesRatio).toBeNull();
    expect(row.responses).toBe(2);
    expect(row.withheld).toBe(true);
  });

  it('never exposes a single response through the serialised report', () => {
    const report = scoreCore4([], {
      teams: [{ team: 'solo', engineers: 1, mergedPrsWeekly: 4, survey: surveyOf(1, 5, 90) }],
    });
    const json = JSON.stringify(report.teams);
    expect(json).not.toContain('"dxi":100');
    expect(json).not.toContain('0.9');
    expect(json).not.toContain('"diffsPerEngineerWeekly":4');
  });
});

describe('core4Changes', () => {
  it('computes area deltas and key metric movement', () => {
    const before = scoreCore4(allSamples());
    const now = scoreCore4(
      allSamples().map(s => (s.metric === 'survey.dxi' ? { ...s, value: 80 } : s)),
    );
    const effectiveness = core4Changes(now, before).find(c => c.area === 'effectiveness')!;
    expect(effectiveness.delta).toBeGreaterThan(0);
    expect(effectiveness.keyBefore).toBe(70);
    expect(effectiveness.keyNow).toBe(80);
  });

  it('gives no delta when one side was unscored', () => {
    const before = scoreCore4(allSamples().filter(s => s.source !== 'devex-survey'));
    const now = scoreCore4(allSamples());
    const effectiveness = core4Changes(now, before).find(c => c.area === 'effectiveness')!;
    expect(effectiveness.delta).toBeNull();
  });
});
