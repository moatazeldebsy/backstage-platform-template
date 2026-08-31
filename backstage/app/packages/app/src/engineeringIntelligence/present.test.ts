// The failure this file prevents: the dashboard showing a number the report did
// not give it.
//
// The scoring engine is careful to withhold a score it cannot justify, and all
// of that care is undone if the page renders `null` as a 0, colours an
// unmeasured dimension like a failing one, or reports "no change" when there is
// simply no history to compare against. This screen is where a fabrication would
// travel furthest — it is the one that gets screenshotted into a board pack.

import type {
  DimensionScore,
  MaturityAssessment,
} from '@internal/engineering-intelligence-core';
import {
  BAND_COLOUR,
  DIMENSION_ORDER,
  SnapshotRow,
  band,
  orderedDimensions,
  trendLabel,
  formatMetricValue,
  formatScore,
  ladder,
  maturityHeadline,
  relativeTime,
  statusLine,
  topRisks,
  trend,
} from './present';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

function snapshot(capturedAt: string, overallScore: number | null): SnapshotRow {
  return {
    capturedAt,
    overallScore,
    status: 'partial',
    maturityLevel: 3,
    maturityConfirmed: false,
    dimensions: {},
  };
}

describe('band', () => {
  it('gives an unscored dimension its own band, not the failing one', () => {
    // Colouring "we could not measure this" the same red as "this is bad" makes
    // a claim the data does not support.
    expect(band(null)).toBe('unknown');
    expect(BAND_COLOUR.unknown).not.toBe(BAND_COLOUR.weak);
  });

  it('bands a real score', () => {
    expect(band(0)).toBe('weak');
    expect(band(49)).toBe('weak');
    expect(band(50)).toBe('fair');
    expect(band(74)).toBe('fair');
    expect(band(75)).toBe('strong');
    expect(band(100)).toBe('strong');
  });
});

describe('formatScore', () => {
  it('renders a null score as a dash, never as zero', () => {
    expect(formatScore(null)).toBe('—');
  });

  it('rounds a real score', () => {
    expect(formatScore(89.1)).toBe('89');
    expect(formatScore(0)).toBe('0');
  });
});

describe('formatMetricValue', () => {
  it('reads units off the metric id', () => {
    // Evidence rows arrive on wildly different scales — a 0.5 ratio, 45 minutes,
    // 4.5 percent — and showing them bare makes the table unreadable.
    expect(formatMetricValue('catalog.goldenPathAdoption', 0.5)).toBe('50%');
    expect(formatMetricValue('finops.costEfficiencyRatio', 0.5159)).toBe('51.6%');
    expect(formatMetricValue('dora.changeFailureRatePercent', 4.5)).toBe('4.5%');
    expect(formatMetricValue('dora.deployFrequencyPerDay', 1.75)).toBe('1.75/day');
    expect(formatMetricValue('devex.prCycleTimeHours', 8.25)).toBe('8.3 hr');
  });

  it('switches minutes to hours past an hour', () => {
    expect(formatMetricValue('dora.mttrMinutes', 45)).toBe('45 min');
    expect(formatMetricValue('dora.leadTimeMinutes', 90)).toBe('1.5 hr');
  });

  it('falls back to a plain number for an unrecognised suffix', () => {
    expect(formatMetricValue('some.newMetric', 12.345)).toBe('12.35');
  });
});

describe('statusLine', () => {
  function dim(over: Partial<DimensionScore>): DimensionScore {
    return {
      dimension: 'devEx',
      score: null,
      status: 'insufficient-evidence',
      coverage: 0.25,
      evidence: [],
      missing: [],
      ...over,
    } as DimensionScore;
  }

  it('names the source an unscored dimension is waiting on', () => {
    // "Insufficient evidence" alone is a dead end; naming the collector turns it
    // into something a platform team can act on.
    const line = statusLine(
      dim({
        missing: [
          { metric: 'devex.prCycleTimeHours', expectedFrom: 'github', reason: 'x' },
          { metric: 'devex.ciDurationMinutes', expectedFrom: 'github', reason: 'x' },
        ],
      }),
    );
    expect(line).toContain('Insufficient evidence');
    expect(line).toContain('github');
    // The source is named once, not once per missing metric.
    expect(line.match(/github/g)).toHaveLength(1);
  });

  it('reports coverage and the missing count when partially scored', () => {
    const line = statusLine(
      dim({
        status: 'partial',
        score: 89.1,
        coverage: 0.6,
        missing: [
          { metric: 'scorecard.checksPassedRatio', expectedFrom: 'techInsights', reason: 'x' },
        ],
      }),
    );
    expect(line).toBe('60% signal coverage · 1 signal missing');
  });

  it('says so plainly when everything was collected', () => {
    expect(statusLine(dim({ status: 'ok', score: 75, coverage: 1 }))).toBe(
      'All signals collected',
    );
  });
});

describe('trend', () => {
  it('returns undefined rather than zero when there is no history', () => {
    // "0" reads as "no change", which is a different and false claim on a
    // platform whose snapshots begin at first install and cannot be back-filled.
    expect(trend([])).toBeUndefined();
    expect(trend([snapshot('2026-08-28T12:00:00.000Z', 82)])).toBeUndefined();
  });

  it('measures against the oldest snapshot available', () => {
    const movement = trend([
      snapshot('2026-08-28T12:00:00.000Z', 82),
      snapshot('2026-08-27T12:00:00.000Z', 79),
      snapshot('2026-08-21T12:00:00.000Z', 74),
    ]);
    expect(movement).toEqual({ delta: 8, since: '2026-08-21T12:00:00.000Z' });
  });

  it('ignores snapshots whose overall score was withheld', () => {
    const movement = trend([
      snapshot('2026-08-28T12:00:00.000Z', 82),
      snapshot('2026-08-27T12:00:00.000Z', null),
      snapshot('2026-08-26T12:00:00.000Z', 80),
    ]);
    expect(movement?.delta).toBe(2);
    expect(movement?.since).toBe('2026-08-26T12:00:00.000Z');
  });

  it('returns undefined when every scored snapshot is the same collection', () => {
    const movement = trend([
      snapshot('2026-08-28T12:00:00.000Z', 82),
      snapshot('2026-08-28T12:00:00.000Z', 82),
    ]);
    expect(movement).toBeUndefined();
  });

  it('reports a decline as a negative delta', () => {
    const movement = trend([
      snapshot('2026-08-28T12:00:00.000Z', 70),
      snapshot('2026-08-20T12:00:00.000Z', 78),
    ]);
    expect(movement?.delta).toBe(-8);
  });
});

describe('trendLabel', () => {
  // Found by screenshotting the running dashboard: two real collections that
  // agreed rendered as "▲ 0", which reads as an improvement of nothing and
  // points the arrow the wrong way for a figure that did not move.
  it('says unchanged rather than showing a zero delta with an arrow', () => {
    const label = trendLabel({ delta: 0, since: '2026-08-28T11:00:00.000Z' }, NOW);
    expect(label).toBe('Unchanged since 60 min ago');
    expect(label).not.toContain('▲');
    expect(label).not.toContain('▼');
  });

  it('points the arrow with the movement', () => {
    expect(trendLabel({ delta: 8, since: '2026-08-28T11:00:00.000Z' }, NOW)).toBe(
      '▲ 8 since 60 min ago',
    );
    expect(trendLabel({ delta: -5.5, since: '2026-08-28T11:00:00.000Z' }, NOW)).toBe(
      '▼ 5.5 since 60 min ago',
    );
  });

  it('states the absence of history rather than implying stability', () => {
    expect(trendLabel(undefined, NOW)).toMatch(/No trend yet/);
  });
});

describe('orderedDimensions', () => {
  // Found by screenshotting the running dashboard: the cards came out in an
  // arbitrary order, because the report round-trips through a Postgres jsonb
  // column and jsonb does not preserve object key order.
  it('renders in the declared order regardless of the object key order', () => {
    const scrambled: any = {
      finops: { dimension: 'finops' },
      devEx: { dimension: 'devEx' },
      platform: { dimension: 'platform' },
      security: { dimension: 'security' },
      quality: { dimension: 'quality' },
      aiEngineering: { dimension: 'aiEngineering' },
      reliability: { dimension: 'reliability' },
    };
    expect(orderedDimensions(scrambled).map(d => d.dimension)).toEqual(
      DIMENSION_ORDER,
    );
  });

  it('leads with Platform Engineering', () => {
    expect(DIMENSION_ORDER[0]).toBe('platform');
  });

  it('skips a dimension the report omitted', () => {
    const partial: any = { platform: { dimension: 'platform' } };
    expect(orderedDimensions(partial).map(d => d.dimension)).toEqual(['platform']);
  });

  it('still renders a dimension this build does not know about', () => {
    // A backend one version ahead must not have its new dimension vanish.
    const withNew: any = {
      platform: { dimension: 'platform' },
      somethingNew: { dimension: 'somethingNew' },
    };
    expect(orderedDimensions(withNew).map(d => d.dimension)).toEqual([
      'platform',
      'somethingNew',
    ]);
  });
});

describe('relativeTime', () => {
  it('renders recent, hourly and daily distances', () => {
    expect(relativeTime('2026-08-28T11:59:30.000Z', NOW)).toBe('just now');
    expect(relativeTime('2026-08-28T11:20:00.000Z', NOW)).toBe('40 min ago');
    expect(relativeTime('2026-08-28T06:00:00.000Z', NOW)).toBe('6 hr ago');
    expect(relativeTime('2026-08-24T12:00:00.000Z', NOW)).toBe('4 days ago');
  });

  it('does not render a future timestamp as a negative age', () => {
    expect(relativeTime('2026-08-28T13:00:00.000Z', NOW)).toBe('just now');
  });

  it('survives an unparseable timestamp', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('unknown');
  });
});

describe('topRisks', () => {
  it('passes the report\'s own recommendations through, capped', () => {
    // The page must not derive its own risks. A risk here and a recommendation
    // from the API have to be the same object, or the two disagree the moment
    // either changes.
    const recommendations = Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`,
      dimension: 'platform' as const,
      severity: 'warning' as const,
      title: `t${i}`,
      action: 'do something',
      evidence: [],
    }));
    const risks = topRisks({ recommendations }, 4);
    expect(risks).toHaveLength(4);
    expect(risks.map(r => r.id)).toEqual(['r0', 'r1', 'r2', 'r3']);
  });

  it('is empty when nothing measured is off target', () => {
    expect(topRisks({ recommendations: [] })).toEqual([]);
  });
});

describe('ladder and maturityHeadline', () => {
  const maturity: MaturityAssessment = {
    currentLevel: 3,
    currentLevelName: 'Platform Enabled',
    confirmed: false,
    summary: 'Level 3 — Platform Enabled (unconfirmed above 3)',
    targetLevel: 4,
    gap: [],
    recommendedActions: [],
    levels: [
      { level: 1, name: 'Ad Hoc', description: '', status: 'met', requirements: [] },
      { level: 2, name: 'Standardised', description: '', status: 'met', requirements: [] },
      { level: 3, name: 'Platform Enabled', description: '', status: 'met', requirements: [] },
      {
        level: 4,
        name: 'AI Enabled',
        description: '',
        status: 'unconfirmed',
        requirements: [
          {
            requirement: {
              kind: 'dimension',
              dimension: 'devEx',
              minScore: 60,
              because: 'x',
            },
            status: 'unmeasurable',
            actual: null,
            detail: 'devEx has insufficient evidence',
          },
          {
            requirement: {
              kind: 'dimension',
              dimension: 'security',
              minScore: 60,
              because: 'x',
            },
            status: 'unmet',
            actual: 41,
            detail: 'security scores 41',
          },
        ],
      },
      {
        level: 5,
        name: 'Autonomous Engineering',
        description: '',
        status: 'unconfirmed',
        requirements: [
          {
            requirement: {
              kind: 'capability',
              capability: 'Approval-gated agent actions, enforced and measured',
              because: 'x',
            },
            status: 'unmeasurable',
            actual: null,
            detail: 'Not measurable today',
          },
        ],
      },
    ],
  } as MaturityAssessment;

  it('marks the current level exactly once', () => {
    const rows = ladder(maturity);
    expect(rows.filter(r => r.current).map(r => r.level)).toEqual([3]);
  });

  it('distinguishes an unmeasurable blocker from a failing one', () => {
    const level4 = ladder(maturity).find(r => r.level === 4)!;
    expect(level4.blockers).toEqual([
      'Developer Experience ≥ 60 (not measurable)',
      'Security ≥ 60 (now 41)',
    ]);
  });

  it('renders a capability blocker by name', () => {
    const level5 = ladder(maturity).find(r => r.level === 5)!;
    expect(level5.blockers).toEqual([
      'Approval-gated agent actions, enforced and measured (not measurable)',
    ]);
  });

  it('lists no blockers for a met level', () => {
    expect(ladder(maturity).find(r => r.level === 2)!.blockers).toEqual([]);
  });

  it('spells out that an unconfirmed level is unknown, not failed', () => {
    // "We are not Level 4" and "we cannot tell whether we are Level 4" lead to
    // different decisions, so the headline must not blur them.
    expect(maturityHeadline(maturity)).toContain('cannot be assessed');
    expect(maturityHeadline({ ...maturity, confirmed: true })).toContain('Next: Level 4');
    expect(maturityHeadline({ ...maturity, confirmed: true })).not.toContain(
      'cannot be assessed',
    );
  });
});
