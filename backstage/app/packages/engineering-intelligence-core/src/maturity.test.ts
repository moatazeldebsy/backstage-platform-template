// The failure this file prevents: awarding a maturity level the evidence does
// not support.
//
// Three ways that happens, each pinned below. Averaging dimensions so a strong
// Reliability score carries a non-existent platform. Skipping a level because
// the dimensions of a *higher* one happen to score well. And — the one that
// matters most here — treating "we could not measure Developer Experience" as
// "Developer Experience is fine", which would quietly promote most installations
// to Level 4 on no data at all.

import { LEVELS, assessMaturity } from './maturity';
import { DimensionId, DimensionScore, Recommendation } from './model';
import { DIMENSION_IDS } from './model';

function scored(dimension: DimensionId, score: number): DimensionScore {
  return {
    dimension,
    score,
    status: 'ok',
    coverage: 1,
    evidence: [],
    missing: [],
  };
}

function unmeasured(
  dimension: DimensionId,
  missing: string[] = [],
): DimensionScore {
  return {
    dimension,
    score: null,
    status: 'insufficient-evidence',
    coverage: 0.25,
    evidence: [],
    missing: missing.map(metric => ({
      metric,
      expectedFrom: 'github (not yet collected — phase 5)',
      reason: `No sample was collected for ${metric}.`,
    })),
  };
}

/** Every dimension scored at `score`, then overridden per dimension. */
function dimensions(
  overrides: Partial<Record<DimensionId, DimensionScore>> = {},
  base = 90,
): Record<DimensionId, DimensionScore> {
  const out = {} as Record<DimensionId, DimensionScore>;
  for (const id of DIMENSION_IDS) out[id] = scored(id, base);
  return { ...out, ...overrides };
}

describe('LEVELS', () => {
  it('declares five levels, numbered in order', () => {
    expect(LEVELS.map(l => l.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives Level 1 no requirements — it is the floor, not an achievement', () => {
    expect(LEVELS[0].requirements).toEqual([]);
  });

  it('justifies every requirement', () => {
    // A threshold with no stated reason is a number someone will argue with and
    // nobody can defend. `because` is what makes the model reviewable.
    for (const level of LEVELS) {
      for (const requirement of level.requirements) {
        expect(requirement.because.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('assessMaturity', () => {
  it('places a fully healthy organisation as high as the evidence allows', () => {
    const result = assessMaturity(dimensions({}, 95));
    // Level 5 carries two capability requirements nothing measures, so 4 is the
    // ceiling reachable from scores — by design.
    expect(result.currentLevel).toBe(4);
    expect(result.confirmed).toBe(false);
    expect(result.summary).toContain('unconfirmed above 4');
  });

  it('holds the level down for one weak dimension rather than averaging it away', () => {
    // Excellent everywhere except platform, which is the whole point: an
    // organisation with great reliability and no platform is not Platform
    // Enabled, and an average would say it was.
    const result = assessMaturity(
      dimensions({ platform: scored('platform', 45) }, 95),
    );
    expect(result.currentLevel).toBe(2);
    expect(result.confirmed).toBe(true);
    expect(result.summary).toBe('Level 2 — Standardised');
  });

  it('cannot skip a level by scoring well on a higher one', () => {
    // Level 4's dimensions are perfect; Level 2's quality floor is not met.
    const result = assessMaturity(
      dimensions(
        {
          quality: scored('quality', 20),
          aiEngineering: scored('aiEngineering', 100),
          security: scored('security', 100),
        },
        95,
      ),
    );
    expect(result.currentLevel).toBe(1);
    expect(result.levels.find(l => l.level === 4)!.status).toBe('met');
  });

  it('reports unconfirmed — not failed — when the next level cannot be measured', () => {
    // The realistic case today: everything collectable is strong, but Developer
    // Experience has no source, so Level 4 can be neither awarded nor ruled out.
    const result = assessMaturity(
      dimensions(
        {
          devEx: unmeasured('devEx', [
            'devex.prCycleTimeHours',
            'devex.ciDurationMinutes',
          ]),
        },
        90,
      ),
    );

    expect(result.currentLevel).toBe(3);
    expect(result.confirmed).toBe(false);
    expect(result.summary).toBe(
      'Level 3 — Platform Enabled (unconfirmed above 3)',
    );
    expect(result.levels.find(l => l.level === 4)!.status).toBe('unconfirmed');
  });

  it('names the missing metrics behind an unmeasurable requirement', () => {
    const result = assessMaturity(
      dimensions(
        { devEx: unmeasured('devEx', ['devex.prCycleTimeHours']) },
        90,
      ),
    );
    const blocked = result.gap.find(
      r =>
        r.requirement.kind === 'dimension' &&
        r.requirement.dimension === 'devEx',
    )!;
    expect(blocked.status).toBe('unmeasurable');
    expect(blocked.actual).toBeNull();
    expect(blocked.detail).toContain('devex.prCycleTimeHours');
  });

  it('lets a definite failure outrank missing evidence', () => {
    // Knowing you fall short is knowing something. A level with one genuine
    // failure is `unmet`, even if another requirement could not be measured —
    // otherwise a real shortfall hides behind a data gap.
    const result = assessMaturity(
      dimensions(
        {
          devEx: unmeasured('devEx'),
          aiEngineering: scored('aiEngineering', 10),
        },
        90,
      ),
    );
    expect(result.levels.find(l => l.level === 4)!.status).toBe('unmet');
    expect(result.currentLevel).toBe(3);
    expect(result.confirmed).toBe(true);
  });

  it('keeps Level 5 out of reach of scores alone', () => {
    // Nothing measures whether the approval gate is enforced or whether agent
    // remediation works. Awarding Autonomous Engineering for a high AI score
    // would make exactly the claim there is no evidence for.
    const result = assessMaturity(dimensions({}, 100));
    const five = result.levels.find(l => l.level === 5)!;
    expect(five.status).toBe('unconfirmed');
    expect(
      five.requirements.filter(r => r.status === 'unmeasurable').length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.currentLevel).toBeLessThan(5);
  });

  it('returns Level 1 when nothing at all could be scored', () => {
    const none = {} as Record<DimensionId, DimensionScore>;
    for (const id of DIMENSION_IDS) none[id] = unmeasured(id);

    const result = assessMaturity(none);
    expect(result.currentLevel).toBe(1);
    expect(result.currentLevelName).toBe('Ad Hoc');
    expect(result.confirmed).toBe(false);
    expect(result.summary).toContain('unconfirmed above 1');
  });

  it('targets the next level and lists only its unmet requirements as the gap', () => {
    const result = assessMaturity(
      dimensions({ platform: scored('platform', 45) }, 95),
    );

    expect(result.targetLevel).toBe(3);
    expect(result.gap).toHaveLength(1);
    expect(
      result.gap[0].requirement.kind === 'dimension' &&
        result.gap[0].requirement.dimension,
    ).toBe('platform');
    expect(result.gap[0].status).toBe('unmet');
    expect(result.gap[0].actual).toBe(45);
  });

  it('carries forward only the recommendations that bear on the gap', () => {
    // A recommendation about a dimension already clearing the next floor is real
    // advice, but it is not what moves the organisation up — mixing the two
    // makes the gap unreadable.
    const recommendations: Recommendation[] = [
      {
        id: 'catalog.goldenPathAdoption',
        dimension: 'platform',
        severity: 'warning',
        title: 'Golden-path adoption is below target',
        action: 'Move services onto an approved template.',
        evidence: [],
      },
      {
        id: 'finops.costEfficiencyRatio',
        dimension: 'finops',
        severity: 'warning',
        title: 'Efficiency is below target',
        action: 'Rightsize workloads.',
        evidence: [],
      },
    ];

    const result = assessMaturity(
      dimensions({ platform: scored('platform', 45) }, 95),
      recommendations,
    );

    expect(result.recommendedActions.map(r => r.id)).toEqual([
      'catalog.goldenPathAdoption',
    ]);
  });

  it('reports every level, met or not, so the whole ladder is visible', () => {
    const result = assessMaturity(dimensions({}, 55));
    expect(result.levels.map(l => l.level)).toEqual([1, 2, 3, 4, 5]);
    for (const level of result.levels) {
      expect(['met', 'unmet', 'unconfirmed']).toContain(level.status);
    }
  });

  it('states the actual score against the floor in every dimension result', () => {
    const result = assessMaturity(
      dimensions({ quality: scored('quality', 51) }, 95),
    );
    const two = result.levels.find(l => l.level === 2)!;
    const quality = two.requirements.find(
      r =>
        r.requirement.kind === 'dimension' &&
        r.requirement.dimension === 'quality',
    )!;
    expect(quality.status).toBe('met');
    expect(quality.actual).toBe(51);
    expect(quality.detail).toContain('51');
    expect(quality.detail).toContain('50');
  });
});
