// The failure this file prevents: spend with no owner being quietly given one.
//
// Attribution here is by naming convention, not an explicit key — a trace is
// joined to a catalog entity through its name. That is workable and it is also
// fragile, so the unattributed remainder has to survive all the way to the
// report. The tempting bugs are redistributing it across the teams that *are*
// known, dropping it so the columns add up, or reading "nothing was spent" as
// "everything was attributed".

import {
  TraceCost,
  costRecommendations,
  deriveWorkload,
  summariseAiCost,
} from './aiCost';

const OBSERVED = '2026-08-29T09:00:00.000Z';

function trace(name: string, costUsd: number): TraceCost {
  return { name, costUsd, observedAt: OBSERVED };
}

const OWNERS = {
  'platform-assistant': 'team-platform',
  'idp-mcp-server': 'team-platform',
  'cost-agent': 'team-finops',
};

describe('deriveWorkload', () => {
  it('reads the agent out of a KAgent A2A trace name', () => {
    expect(deriveWorkload('/a2a/kagent/platform-assistant')).toBe(
      'platform-assistant',
    );
    expect(deriveWorkload('/a2a/default/cost-agent')).toBe('cost-agent');
  });

  it('reads the server out of an MCP tool trace name', () => {
    // telemetry.ts writes `${serverName}.${toolName}`.
    expect(deriveWorkload('idp-mcp-server.catalog_search')).toBe(
      'idp-mcp-server',
    );
    expect(deriveWorkload('cost-mcp-server.get_team_spend')).toBe(
      'cost-mcp-server',
    );
  });

  it('returns undefined rather than guessing at an unrecognised name', () => {
    // An unrecognised name must stay unattributed. Forcing it into a bucket is
    // how spend acquires an owner that never incurred it.
    expect(deriveWorkload('some random trace')).toBeUndefined();
    expect(deriveWorkload('')).toBeUndefined();
    expect(deriveWorkload('Capitalised.Thing')).toBeUndefined();
  });
});

describe('summariseAiCost', () => {
  it('splits spend by workload and by owning team', () => {
    const report = summariseAiCost(
      [
        trace('/a2a/kagent/platform-assistant', 4),
        trace('idp-mcp-server.catalog_search', 1),
        trace('/a2a/kagent/cost-agent', 5),
      ],
      OWNERS,
      [],
      { generatedAt: OBSERVED },
    );

    expect(report.totalUsd).toBe(10);
    expect(report.byTeam).toEqual([
      { key: 'team-platform', costUsd: 5, traces: 2 },
      { key: 'team-finops', costUsd: 5, traces: 1 },
    ]);
    expect(report.byWorkload[0].key).toBe('cost-agent');
  });

  it('keeps unattributable spend separate instead of redistributing it', () => {
    // The core guarantee. $6 belongs to nobody, and must not be shared out
    // across the teams that happen to be known.
    const report = summariseAiCost(
      [
        trace('/a2a/kagent/platform-assistant', 4),
        trace('mystery workload', 6),
      ],
      OWNERS,
      [],
      { generatedAt: OBSERVED },
    );

    expect(report.totalUsd).toBe(10);
    expect(report.attributedUsd).toBe(4);
    expect(report.unattributedUsd).toBe(6);
    expect(report.attributedRatio).toBeCloseTo(0.4);
    expect(report.byTeam.reduce((t, b) => t + b.costUsd, 0)).toBe(4);
    expect(report.unmatchedNames).toEqual(['mystery workload']);
  });

  it('treats a parsed name with no catalog owner as unattributed', () => {
    // Parsing a name is not knowing who owns it. An agent absent from the
    // catalog has spend and no owner, and inventing one would be the whole
    // failure this guards.
    const report = summariseAiCost(
      [trace('/a2a/kagent/unknown-agent', 3)],
      OWNERS,
      [],
      { generatedAt: OBSERVED },
    );

    expect(report.attributedUsd).toBe(0);
    expect(report.unattributedUsd).toBe(3);
    expect(report.byTeam).toEqual([]);
  });

  it('reports a null ratio, not 100%, when nothing was spent', () => {
    // A platform with no AI traffic has not attributed its spend perfectly — it
    // has no spend to attribute.
    const report = summariseAiCost([], OWNERS, [], { generatedAt: OBSERVED });
    expect(report.totalUsd).toBe(0);
    expect(report.attributedRatio).toBeNull();
  });

  it('ranks teams and models by spend, largest first', () => {
    const report = summariseAiCost(
      [
        trace('/a2a/kagent/platform-assistant', 1),
        trace('/a2a/kagent/cost-agent', 9),
      ],
      OWNERS,
      [
        { model: 'cheap', costUsd: 1, inputTokens: 10, outputTokens: 5 },
        { model: 'expensive', costUsd: 9, inputTokens: 90, outputTokens: 45 },
      ],
      { generatedAt: OBSERVED },
    );

    expect(report.byTeam[0].key).toBe('team-finops');
    expect(report.byModel[0].model).toBe('expensive');
  });

  it('states the window, so "total" means something', () => {
    const report = summariseAiCost([], OWNERS, [], { windowDays: 30 });
    expect(report.windowDays).toBe(30);
  });
});

describe('costRecommendations', () => {
  it('flags unattributed spend with the figure behind it', () => {
    const report = summariseAiCost(
      [trace('/a2a/kagent/platform-assistant', 2), trace('mystery', 8)],
      OWNERS,
      [],
      { generatedAt: OBSERVED },
    );

    const rec = costRecommendations(report).find(
      r => r.id === 'ai.cost.unattributed',
    )!;
    expect(rec).toBeDefined();
    expect(rec.evidence).toContain('$8');
    expect(rec.action).toMatch(/trace names/);
  });

  it('says nothing about attribution when nearly all spend has an owner', () => {
    const report = summariseAiCost(
      [trace('/a2a/kagent/platform-assistant', 10)],
      OWNERS,
      [],
      { generatedAt: OBSERVED },
    );
    expect(costRecommendations(report).map(r => r.id)).not.toContain(
      'ai.cost.unattributed',
    );
  });

  it('reports model concentration as a fact, without inventing a saving', () => {
    // Deliberately absent: "move low-complexity summarisation to a cheaper
    // model, saving $2,140". Nothing here knows a workload's complexity, and a
    // saving figure derived from a guess about it would be fabrication.
    const report = summariseAiCost(
      [trace('/a2a/kagent/platform-assistant', 10)],
      OWNERS,
      [
        { model: 'opus', costUsd: 9.5, inputTokens: 100, outputTokens: 50 },
        { model: 'haiku', costUsd: 0.5, inputTokens: 100, outputTokens: 50 },
      ],
      { generatedAt: OBSERVED },
    );

    const rec = costRecommendations(report).find(
      r => r.id === 'ai.cost.modelConcentration',
    )!;
    expect(rec.title).toMatch(/95% of AI spend/);
    expect(rec.evidence).toContain('opus');
    // No invented saving anywhere in the advice.
    for (const r of costRecommendations(report)) {
      expect(r.action).not.toMatch(/sav(e|ing)s? \$/i);
    }
  });

  it('produces nothing at all when there is no spend', () => {
    expect(costRecommendations(summariseAiCost([], OWNERS))).toEqual([]);
  });
});
