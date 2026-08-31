// Two failures this file prevents, and they are the two that would matter most.
//
// **Leaking source data into a prompt.** The advisor sees the scored report, not
// what produced it. Evidence `labels` carry user ids, raw trace names and cost
// strings; AI cost carries `unmatchedNames`, which is uncontrolled text written
// by whatever emitted the trace. None of it is needed to answer any question
// here, and all of it would leave the platform the moment a model is wired up.
//
// **Answering a question the data cannot support.** "Team A is understaffed" is
// the canonical bad answer — fluent, plausible, and backed by nothing. Where the
// evidence runs out the advisor has to say so.

import { AiCostReport } from './aiCost';
import {
  AdvisorContext,
  SnapshotSummary,
  answer,
  buildAdvisorContext,
  citableMetrics,
  dimensionChanges,
  overallChange,
  unsupportedCitations,
} from './advisor';
import { HealthReport, MetricSample } from './model';
import { scoreHealth } from './score';

const OBSERVED = '2026-08-29T09:00:00.000Z';

function sample(
  metric: string,
  value: number,
  source = 'prometheus',
): MetricSample {
  return { metric, value, source, observedAt: OBSERVED };
}

function report(): HealthReport {
  return scoreHealth(
    [
      sample('catalog.ownershipCoverage', 1, 'catalog'),
      sample('catalog.goldenPathAdoption', 0.2, 'catalog'),
      sample('dora.changeFailureRatePercent', 4),
      sample('dora.mttrMinutes', 30),
      sample('finops.costEfficiencyRatio', 0.4, 'opencost'),
      sample('finops.budgetUtilisationRatio', 0.8),
    ],
    { generatedAt: OBSERVED },
  );
}

function snapshot(
  capturedAt: string,
  overall: number,
  dims: Record<string, number | null>,
): SnapshotSummary {
  return { capturedAt, overallScore: overall, dimensions: dims };
}

describe('buildAdvisorContext — what a model is allowed to see', () => {
  it('strips evidence labels, where the sensitive values live', () => {
    const withLabels = scoreHealth(
      [
        {
          metric: 'dora.changeFailureRatePercent',
          value: 4,
          source: 'prometheus',
          observedAt: OBSERVED,
          labels: {
            user: 'user:default/alice',
            traceName: '/a2a/kagent/secret-agent',
          },
        },
        sample('dora.mttrMinutes', 30),
      ],
      { generatedAt: OBSERVED },
    );

    const context = buildAdvisorContext(withLabels);
    const serialised = JSON.stringify(context);

    expect(serialised).not.toContain('alice');
    expect(serialised).not.toContain('secret-agent');
    for (const dimension of context.dimensions) {
      for (const row of dimension.evidence) {
        expect(Object.keys(row).sort()).toEqual(['metric', 'source', 'value']);
      }
    }
  });

  it('reduces AI spend to team totals and drops raw trace names', () => {
    // unmatchedNames is text written by whatever emitted the trace. It is
    // exactly the kind of uncontrolled input that should never reach a prompt.
    const cost: AiCostReport = {
      generatedAt: OBSERVED,
      windowDays: 7,
      totalUsd: 10,
      attributedUsd: 8,
      unattributedUsd: 2,
      attributedRatio: 0.8,
      byWorkload: [{ key: 'platform-assistant', costUsd: 8, traces: 4 }],
      byTeam: [{ key: 'team-platform', costUsd: 8, traces: 4 }],
      byModel: [],
      unmatchedNames: ['/a2a/kagent/customer-pii-agent'],
    };

    const context = buildAdvisorContext(report(), { cost });
    const serialised = JSON.stringify(context);

    expect(context.aiSpend?.byTeam).toEqual([
      { team: 'team-platform', costUsd: 8 },
    ]);
    expect(serialised).not.toContain('customer-pii-agent');
    expect(serialised).not.toContain('byWorkload');
  });

  it('omits AI spend entirely when none was recorded', () => {
    expect(buildAdvisorContext(report()).aiSpend).toBeUndefined();
  });

  it('carries the maturity blockers, which is what "focus next" needs', () => {
    const context = buildAdvisorContext(report());
    expect(context.maturity.level).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(context.maturity.blockers)).toBe(true);
  });
});

describe('unsupportedCitations — the guardrail', () => {
  it('catches a metric that is not in the context', () => {
    // The canonical failure: a fluent answer citing something invented.
    const context = buildAdvisorContext(report());
    expect(unsupportedCitations(['devex.moraleIndex'], context)).toEqual([
      'devex.moraleIndex',
    ]);
  });

  it('accepts metrics that were collected, and ones that are merely missing', () => {
    // A missing metric is still part of the vocabulary — "we could not measure
    // devex.prCycleTimeHours" is a legitimate claim about the data.
    const context = buildAdvisorContext(report());
    expect(
      unsupportedCitations(
        ['catalog.ownershipCoverage', 'devex.prCycleTimeHours'],
        context,
      ),
    ).toEqual([]);
  });

  it('builds its vocabulary from both collected and missing signals', () => {
    const metrics = citableMetrics(buildAdvisorContext(report()));
    expect(metrics.has('catalog.ownershipCoverage')).toBe(true);
    expect(metrics.has('devex.prCycleTimeHours')).toBe(true);
    expect(metrics.has('nonsense.metric')).toBe(false);
  });
});

describe('change detection', () => {
  const snapshots = [
    snapshot('2026-08-29T09:00:00.000Z', 60, { platform: 50, quality: 70 }),
    snapshot('2026-08-22T09:00:00.000Z', 52, { platform: 40, quality: 70 }),
  ];

  it('reports overall movement with the window it covers', () => {
    expect(overallChange(snapshots)).toEqual({
      delta: 8,
      sinceDays: 7,
      since: '2026-08-22T09:00:00.000Z',
    });
  });

  it('has nothing to say with fewer than two scored snapshots', () => {
    expect(overallChange([])).toBeUndefined();
    expect(overallChange([snapshots[0]])).toBeUndefined();
  });

  it('ranks dimension movements by size and ignores unchanged ones', () => {
    expect(dimensionChanges(snapshots)).toEqual([
      { dimension: 'platform', label: 'Platform Engineering', delta: 10 },
    ]);
  });

  it('skips a dimension that was unscored at either end', () => {
    // "We could not measure it last week" is not a decline, and reporting it as
    // one sends a team chasing a change that never happened.
    const withGap = [
      snapshot('2026-08-29T09:00:00.000Z', 60, { devEx: 80 }),
      snapshot('2026-08-22T09:00:00.000Z', 52, { devEx: null }),
    ];
    expect(dimensionChanges(withGap)).toEqual([]);
  });
});

describe('answer', () => {
  const context = (over: Partial<AdvisorContext> = {}): AdvisorContext => ({
    ...buildAdvisorContext(report()),
    ...over,
  });

  it('ranks the biggest risks from the report, not from judgement', () => {
    const result = answer('biggest-risks', context());
    expect(result.insufficientEvidence).toBe(false);
    expect(result.actions.length).toBeGreaterThan(0);
    // Every cited metric must exist in the context it was answered from.
    expect(unsupportedCitations(result.citedMetrics, context())).toEqual([]);
  });

  it('refuses to rank teams, because nothing here is per-team', () => {
    // The canonical bad answer this whole design exists to prevent. Engineering
    // Health is platform-wide; a ranking of teams would be fabricated.
    const result = answer('teams-needing-attention', context());
    expect(result.insufficientEvidence).toBe(true);
    expect(result.answer).toMatch(/platform-wide/);
    expect(result.citedMetrics).toEqual([]);
  });

  it('answers the team question only as spend, and labels it as such', () => {
    const withSpend = context({
      aiSpend: {
        windowDays: 7,
        totalUsd: 10,
        attributedRatio: 0.8,
        byTeam: [{ team: 'team-platform', costUsd: 8 }],
      },
    });
    const result = answer('teams-needing-attention', withSpend);
    expect(result.answer).toMatch(/spend figure, not a performance one/);
  });

  it('says there is no trend rather than explaining one that does not exist', () => {
    const result = answer('why-changed', context());
    expect(result.insufficientEvidence).toBe(true);
    expect(result.answer).toMatch(/cannot be back-filled/);
  });

  it('explains a real movement by dimension', () => {
    const moved = context({ trend: { deltaOverall: -8, sinceDays: 7 } });
    const result = answer('why-changed', moved, {
      changes: [
        { dimension: 'quality', label: 'Quality Engineering', delta: -12 },
      ],
    });
    expect(result.insufficientEvidence).toBe(false);
    expect(result.answer).toMatch(/fell 8 points over 7 day/);
    expect(result.answer).toMatch(/Quality Engineering -12/);
  });

  it('offers no saving figure when asked how to reduce cost', () => {
    // Nothing measures workload complexity, so "move X to a cheaper model and
    // save $N" would be invented — the answer says so instead of guessing.
    const withSpend = context({
      aiSpend: {
        windowDays: 7,
        totalUsd: 40,
        attributedRatio: 0.5,
        byTeam: [],
      },
    });
    const result = answer('reduce-cost', withSpend);
    expect(result.answer).toMatch(/No saving figure is offered/);
    expect(result.answer).not.toMatch(/save \$\d/);
  });

  it('says what AI readiness is missing when it cannot be scored', () => {
    const result = answer('ai-readiness', context());
    expect(result.insufficientEvidence).toBe(true);
    expect(result.answer).toMatch(/Missing:|no AI signals/);
  });

  it('never cites a metric outside the context it was given', () => {
    // The invariant across every question, checked in one place.
    const ctx = context({
      trend: { deltaOverall: -3, sinceDays: 5 },
      aiSpend: { windowDays: 7, totalUsd: 5, attributedRatio: 0.9, byTeam: [] },
    });
    for (const question of [
      'biggest-risks',
      'why-changed',
      'focus-next',
      'teams-needing-attention',
      'ai-readiness',
      'reduce-cost',
    ] as const) {
      const result = answer(question, ctx);
      expect(unsupportedCitations(result.citedMetrics, ctx)).toEqual([]);
    }
  });

  it('marks an unknown question as unanswerable rather than improvising', () => {
    const result = answer('nonsense' as never, context());
    expect(result.insufficientEvidence).toBe(true);
  });
});
