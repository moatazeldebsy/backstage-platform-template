// Two failures this file prevents.
//
// First: one dead source taking the whole report down. Collectors are meant to
// degrade the dimensions that depended on them and leave the rest intact, so a
// Prometheus outage must not blank the catalog-driven Platform score.
//
// Second: the snapshot store silently dropping history. It is the only place in
// the platform where a trend exists at all — Prometheus retains 6h locally and
// 30d on AWS, with no long-term store behind it — so a snapshot that fails to
// round-trip is data that cannot be recovered later.

import { collectAndScore } from '../engineeringIntelligence/collect';
import { CollectorResult } from '../engineeringIntelligence/source';
import {
  ensureSchema,
  latestSnapshot,
  listSnapshots,
  saveSnapshot,
} from '../engineeringIntelligence/store';
import {
  HealthReport,
  assessMaturity,
} from '@internal/engineering-intelligence-core';
import {
  engineeringIntelligencePlugin,
  route,
} from '../idpEngineeringIntelligence';

const OBSERVED = '2026-08-28T09:00:00.000Z';

function ok(metrics: [string, number][], source = 'prometheus'): CollectorResult {
  return {
    samples: metrics.map(([metric, value]) => ({
      metric,
      value,
      source,
      observedAt: OBSERVED,
    })),
  };
}

function down(source: string): CollectorResult {
  return { samples: [], unavailable: { source, reason: `${source} is down` } };
}

describe('collectAndScore', () => {
  it('scores the dimensions whose sources answered when another is down', async () => {
    const outcome = await collectAndScore([
      async () =>
        ok(
          [
            ['catalog.ownershipCoverage', 1],
            ['catalog.goldenPathAdoption', 0.8],
          ],
          'catalog',
        ),
      async () => down('prometheus'),
    ]);

    // Platform had 0.6 of its weight answered — above minCoverage — so it scores.
    expect(outcome.report.dimensions.platform.score).not.toBeNull();
    expect(outcome.report.dimensions.platform.status).toBe('partial');
    // Reliability depended entirely on Prometheus, so it does not.
    expect(outcome.report.dimensions.reliability.score).toBeNull();
    expect(outcome.report.dimensions.reliability.status).toBe(
      'insufficient-evidence',
    );
  });

  it('surfaces every unavailable source with its reason', async () => {
    const outcome = await collectAndScore([
      async () => down('prometheus'),
      async () => down('langfuse'),
      async () => ok([['catalog.ownershipCoverage', 1]], 'catalog'),
    ]);

    expect(outcome.unavailable.map(u => u.source).sort()).toEqual([
      'langfuse',
      'prometheus',
    ]);
    expect(outcome.unavailable[0].reason).toContain('is down');
  });

  it('survives a collector that throws instead of returning', async () => {
    // source.ts swallows transport failures, so a throw here means a bug in the
    // collector. Losing its samples beats losing the entire report.
    const outcome = await collectAndScore([
      async () => {
        throw new Error('boom');
      },
      async () =>
        ok(
          [
            ['dora.changeFailureRatePercent', 2],
            ['dora.mttrMinutes', 30],
          ],
          'prometheus',
        ),
    ]);

    expect(outcome.report.dimensions.reliability.score).toBe(100);
    expect(outcome.unavailable.some(u => u.reason.includes('threw'))).toBe(true);
  });

  it('produces a null overall score when every source is down', async () => {
    // Not a zero. "We could not measure the organisation" and "the organisation
    // scores zero" are different claims, and only one of them is true here.
    const outcome = await collectAndScore([
      async () => down('prometheus'),
      async () => down('catalog'),
    ]);

    expect(outcome.report.overallScore).toBeNull();
    expect(outcome.report.status).toBe('insufficient-evidence');
    expect(outcome.report.recommendations).toEqual([]);
  });

  it('runs with no collectors at all without throwing', async () => {
    const outcome = await collectAndScore([]);
    expect(outcome.report.overallScore).toBeNull();
    expect(outcome.unavailable).toEqual([]);
  });

  it('stamps the generation time it is given', async () => {
    const outcome = await collectAndScore([], { now: () => OBSERVED });
    expect(outcome.report.generatedAt).toBe(OBSERVED);
  });

  it('assesses maturity from the same collection, not a second pass', async () => {
    // The level rides on the report so every persisted snapshot records it.
    // Recomputing it on request instead would mean the level could never be
    // charted over time — the thing leadership actually tracks.
    const outcome = await collectAndScore([
      async () =>
        ok(
          [
            ['catalog.ownershipCoverage', 1],
            ['catalog.goldenPathAdoption', 1],
          ],
          'catalog',
        ),
    ]);

    expect(outcome.report.maturity).toBeDefined();
    expect(outcome.report.maturity.levels).toHaveLength(5);
    // Only platform could be scored, so Level 2's quality and reliability floors
    // are unmeasurable — the assessment must say unconfirmed, not Level 1 flat.
    expect(outcome.report.maturity.currentLevel).toBe(1);
    expect(outcome.report.maturity.confirmed).toBe(false);
  });

  it('reports maturity as unconfirmed above 1 when nothing was collected', async () => {
    const outcome = await collectAndScore([async () => down('prometheus')]);
    expect(outcome.report.maturity.currentLevel).toBe(1);
    expect(outcome.report.maturity.summary).toContain('unconfirmed above 1');
    expect(outcome.report.maturity.recommendedActions).toEqual([]);
  });

  it('applies configured dimension weights', async () => {
    // Enough dimensions to clear the minimum-scored floor: below a third of the
    // model the overall score is withheld entirely, so a two-dimension fixture
    // would compare null against null and prove nothing.
    const collectors = [
      async () =>
        ok(
          [
            ['dora.deployFrequencyPerDay', 2], // so CFR and MTTR are not withheld
            ['dora.changeFailureRatePercent', 40], // reliability scores low
            ['dora.mttrMinutes', 60 * 24 * 30],
            ['catalog.ownershipCoverage', 1], // platform scores high
            ['catalog.goldenPathAdoption', 1],
            ['finops.costEfficiencyRatio', 0.9], // a third scored dimension
            ['finops.budgetUtilisationRatio', 0.75],
          ],
          'mixed',
        ),
    ];
    const flat = await collectAndScore(collectors);
    const tilted = await collectAndScore(collectors, {
      weights: { reliability: 10 },
    });

    expect(tilted.report.overallScore!).toBeLessThan(flat.report.overallScore!);
  });
});

// ── snapshot store ────────────────────────────────────────────────────────────

/**
 * An in-memory stand-in for the knex client, narrow enough to exercise the two
 * things the store actually does: insert a row, and read rows back newest-first.
 * The repo's house style is a hand-built stub rather than a service mock — see
 * makeUser() in idpPermissionPolicy.test.ts.
 */
function fakeDb() {
  const rows: { captured_at: string; report: string }[] = [];
  const builder = (table: string) => {
    if (table !== 'ei_snapshots') throw new Error(`unexpected table ${table}`);
    let limit = Infinity;
    const chain: any = {
      insert: async (row: any) => {
        rows.push(row);
      },
      orderBy: () => chain,
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      select: async () =>
        [...rows]
          .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at))
          .slice(0, limit),
    };
    return chain;
  };
  const db: any = builder;
  db.raw = async () => undefined;
  db.__rows = rows;
  return db;
}

function report(generatedAt: string, overallScore: number | null): HealthReport {
  return {
    generatedAt,
    overallScore,
    status: overallScore === null ? 'insufficient-evidence' : 'partial',
    dimensions: {} as HealthReport['dimensions'],
    recommendations: [],
    maturity: assessMaturity({} as HealthReport['dimensions']),
  };
}

describe('snapshot store', () => {
  it('creates its schema idempotently', async () => {
    const db = fakeDb();
    await ensureSchema(db);
    await ensureSchema(db);
  });

  it('round-trips a report through the jsonb column', async () => {
    const db = fakeDb();
    const original = report(OBSERVED, 74.5);
    await saveSnapshot(db, original);

    const latest = await latestSnapshot(db);
    expect(latest?.report.overallScore).toBe(74.5);
    expect(latest?.report.generatedAt).toBe(OBSERVED);
  });

  it('returns undefined before the first refresh has run', async () => {
    expect(await latestSnapshot(fakeDb())).toBeUndefined();
  });

  it('returns snapshots newest first and honours the limit', async () => {
    const db = fakeDb();
    await saveSnapshot(db, report('2026-08-26T09:00:00.000Z', 70));
    await saveSnapshot(db, report('2026-08-28T09:00:00.000Z', 74));
    await saveSnapshot(db, report('2026-08-27T09:00:00.000Z', 72));

    const all = await listSnapshots(db, 10);
    expect(all.map(s => s.report.overallScore)).toEqual([74, 72, 70]);

    const capped = await listSnapshots(db, 2);
    expect(capped).toHaveLength(2);
    expect(capped[0].report.overallScore).toBe(74);
  });

  it('round-trips the maturity assessment with the report', async () => {
    // A snapshot that drops the level is a level that cannot be charted later,
    // and there is no back-fill — no source retains the history to recompute it.
    const db = fakeDb();
    await saveSnapshot(db, report(OBSERVED, 74.5));

    const latest = await latestSnapshot(db);
    expect(latest?.report.maturity.currentLevel).toBe(1);
    expect(latest?.report.maturity.levels).toHaveLength(5);
  });

  it('preserves a null overall score rather than coercing it', async () => {
    // A stored null is the record that nothing could be measured at that moment.
    // Reading it back as 0 would invent a bad quarter after the fact.
    const db = fakeDb();
    await saveSnapshot(db, report(OBSERVED, null));
    const latest = await latestSnapshot(db);
    expect(latest?.report.overallScore).toBeNull();
  });
});

// ── plugin wiring ─────────────────────────────────────────────────────────────

describe('route', () => {
  // Found by curling an unauthenticated request at the running container: the
  // request hung until the client gave up, and the backend logged an unhandled
  // rejection. Express 4 does not await an async handler, so a rejected promise
  // inside one never becomes a response — httpAuth.credentials() rejecting with
  // AuthenticationError left the socket open forever instead of returning 401.
  function call(handler: ReturnType<typeof route>) {
    const next = jest.fn();
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    handler({} as any, res as any, next);
    return { next, res };
  }

  it('forwards a rejection to next so Express can answer', async () => {
    const boom = new Error('Missing credentials');
    const { next } = call(
      route(async () => {
        throw boom;
      }),
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('leaves a successful handler alone', async () => {
    const { next, res } = call(
      route(async (_req, response) => {
        response.json({ ok: true });
      }),
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('engineeringIntelligencePlugin', () => {
  it('constructs as a Backstage backend plugin', () => {
    // Cheap, but it is the only thing in this suite that exercises the module
    // itself rather than its collaborators — everything else here is pure. A
    // malformed createBackendPlugin call type-checks fine and fails at boot.
    expect(engineeringIntelligencePlugin).toBeDefined();
    expect(typeof engineeringIntelligencePlugin).toBe('object');
  });
});
