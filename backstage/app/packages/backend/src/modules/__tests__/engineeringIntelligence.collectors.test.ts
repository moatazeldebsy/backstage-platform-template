// The failure this file prevents: a collector inventing a number when its source
// is down.
//
// Every dashboard page in extensions.tsx substitutes demo data on failure — a
// reasonable choice for a per-service tab, and the wrong one for an
// organisation-wide health score. These tests pin the opposite contract: a 500,
// a timeout, an empty result and a malformed body all collapse to *no samples*,
// so the scoring engine sees reduced coverage rather than a plausible fiction.
//
// They also lock the parsers against recorded response shapes, because the
// second failure available here is subtler: reading the right source and
// misinterpreting it (the DORA `service="all-services"` roll-up double-counted,
// or OpenCost efficiency read as a percentage when it arrives as a ratio).

import { ConfigReader } from '@backstage/config';
import { catalogSamples, collectCatalog } from '../engineeringIntelligence/catalog';
import {
  collectLangfuse,
  rollup,
} from '../engineeringIntelligence/langfuse';
import {
  asRatio,
  collectOpenCost,
  weightedEfficiency,
} from '../engineeringIntelligence/opencost';
import {
  collectPrometheus,
  vectorCount,
  vectorMean,
  vectorSum,
} from '../engineeringIntelligence/prometheus';
import {
  collectTechInsights,
  techInsightsSamples,
} from '../engineeringIntelligence/techInsights';
import { proxyTarget, safeRatio } from '../engineeringIntelligence/source';

const OBSERVED = '2026-08-28T09:00:00.000Z';

const config = new ConfigReader({
  proxy: {
    endpoints: {
      '/prometheus': { target: 'http://prometheus.idp.local/' },
      '/opencost': { target: 'http://opencost.idp.local' },
      '/langfuse': { target: 'http://langfuse.idp.local' },
    },
  },
  langfuse: { publicKey: 'pk-test', secretKey: 'sk-test' },
});

const ctx = {
  config,
  logger: { warn: jest.fn(), info: jest.fn() },
};

/** Build a Prometheus instant-vector body. */
function vector(...values: [Record<string, string>, string][]) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: values.map(([metric, value]) => ({
        metric,
        value: [1756371600, value] as [number, string],
      })),
    },
  };
}

function mockFetchJson(handler: (url: string) => unknown | undefined) {
  global.fetch = jest.fn(async (input: any) => {
    const url = String(input);
    const body = handler(url);
    if (body === undefined) {
      return { ok: false, status: 503, json: async () => ({}) } as any;
    }
    return { ok: true, status: 200, json: async () => body } as any;
  }) as any;
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ── source helpers ────────────────────────────────────────────────────────────

describe('proxyTarget', () => {
  it('reuses the frontend proxy targets and strips a trailing slash', () => {
    // The Backstage proxy is server-side, so the backend can already reach these
    // hosts. Reusing them means one address per source per environment, not two.
    expect(proxyTarget(config, '/prometheus')).toBe('http://prometheus.idp.local');
    expect(proxyTarget(config, '/opencost')).toBe('http://opencost.idp.local');
  });

  it('returns undefined for an endpoint that is not configured', () => {
    expect(proxyTarget(config, '/nope')).toBeUndefined();
  });
});

describe('safeRatio', () => {
  it('treats zero-of-zero as unobserved, not as zero percent', () => {
    // An empty catalog is not a catalog of unowned services. Returning 0 here
    // would be the most misleading number these collectors could produce.
    expect(safeRatio(0, 0)).toBeUndefined();
    expect(safeRatio(0, 5)).toBe(0);
    expect(safeRatio(3, 4)).toBe(0.75);
  });
});

// ── prometheus ────────────────────────────────────────────────────────────────

describe('prometheus vector helpers', () => {
  it('sums, means and counts an instant vector', () => {
    const body = vector(
      [{ service: 'a' }, '10'],
      [{ service: 'b' }, '20'],
      [{ service: 'c' }, '30'],
    );
    expect(vectorSum(body)).toBe(60);
    expect(vectorMean(body)).toBe(20);
    expect(vectorCount(body)).toBe(3);
  });

  it('returns undefined for an empty vector rather than zero', () => {
    const empty = vector();
    expect(vectorSum(empty)).toBeUndefined();
    expect(vectorMean(empty)).toBeUndefined();
  });

  it('returns undefined when the query never answered', () => {
    expect(vectorSum(undefined)).toBeUndefined();
    expect(vectorMean(undefined)).toBeUndefined();
  });

  it('skips unparseable sample values instead of producing NaN', () => {
    const body = vector([{ service: 'a' }, 'NaN'], [{ service: 'b' }, '10']);
    expect(vectorSum(body)).toBe(10);
  });
});

describe('collectPrometheus', () => {
  it('excludes the synthetic all-services roll-up from DORA queries', () => {
    // dora-exporter.py emits a service="all-services" aggregate alongside the
    // per-service rows. Averaging across both would weight the aggregate as if
    // it were one more service.
    const urls: string[] = [];
    mockFetchJson(url => {
      urls.push(url);
      return vector([{ service: 'a' }, '1']);
    });
    return collectPrometheus(ctx).then(() => {
      const dora = urls.filter(u => u.includes('dora_'));
      expect(dora.length).toBe(4);
      for (const url of dora) {
        expect(decodeURIComponent(url)).toContain('service!="all-services"');
      }
    });
  });

  it('maps the real dora_* series names', async () => {
    // docs/dora-finops.md documented idp_deploy_frequency / idp_lead_time_seconds
    // and similar. Those series do not exist; these are the ones the exporter
    // actually pushes.
    const urls: string[] = [];
    mockFetchJson(url => {
      urls.push(url);
      return vector([{ service: 'a' }, '2']);
    });
    await collectPrometheus(ctx);
    const joined = urls.map(u => decodeURIComponent(u)).join(' ');
    expect(joined).toContain('dora_deploy_frequency_per_day');
    expect(joined).toContain('dora_lead_time_minutes');
    expect(joined).toContain('dora_change_failure_rate_percent');
    expect(joined).toContain('dora_mttr_minutes');
    expect(joined).not.toContain('idp_deploy_frequency');
  });

  it('derives a test pass rate from the pass and fail counters', async () => {
    mockFetchJson(url => {
      const q = decodeURIComponent(url);
      if (q.includes('idp_test_pass_total')) return vector([{}, '90']);
      if (q.includes('idp_test_fail_total')) return vector([{}, '10']);
      if (q.includes('dora_')) return vector([{ service: 'a' }, '1']);
      return vector();
    });
    const result = await collectPrometheus(ctx);
    const passRate = result.samples.find(s => s.metric === 'test.passRate');
    expect(passRate?.value).toBeCloseTo(0.9);
  });

  it('reports the source unavailable when no DORA query answers', async () => {
    mockFetchJson(() => undefined);
    const result = await collectPrometheus(ctx);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.source).toBe('prometheus');
  });

  it('reports unavailable when no prometheus proxy target is configured', async () => {
    const bare = { config: new ConfigReader({}), logger: ctx.logger };
    const result = await collectPrometheus(bare);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/not configured|No proxy/);
  });

  it('omits a metric whose query returned nothing, rather than scoring it zero', async () => {
    mockFetchJson(url =>
      decodeURIComponent(url).includes('dora_') ? vector([{ service: 'a' }, '1']) : vector(),
    );
    const result = await collectPrometheus(ctx);
    expect(result.samples.map(s => s.metric)).not.toContain('test.flakinessRatio');
    expect(result.samples.map(s => s.metric)).toContain('dora.mttrMinutes');
  });
});

// ── catalog ───────────────────────────────────────────────────────────────────

describe('catalogSamples', () => {
  const scaffolded = {
    kind: 'Component',
    metadata: {
      name: 'a',
      annotations: { 'backstage.io/source-template': 'template:default/go-service' },
    },
    spec: { owner: 'team-a' },
  };
  const handRolled = {
    kind: 'Component',
    metadata: { name: 'b', annotations: {} },
    spec: { owner: 'team-b' },
  };
  const unowned = { kind: 'Component', metadata: { name: 'c' }, spec: {} };

  it('reads golden-path adoption from the scaffolder provenance annotation', () => {
    // backstage.io/source-template is stamped by the scaffolder on every entity
    // it creates, so this is provenance rather than a proxy.
    const samples = catalogSamples([scaffolded, handRolled], OBSERVED);
    const adoption = samples.find(s => s.metric === 'catalog.goldenPathAdoption');
    expect(adoption?.value).toBe(0.5);
  });

  it('counts an entity with a blank owner as unowned', () => {
    const samples = catalogSamples(
      [scaffolded, unowned, { ...handRolled, spec: { owner: '  ' } }],
      OBSERVED,
    );
    const ownership = samples.find(s => s.metric === 'catalog.ownershipCoverage');
    expect(ownership?.value).toBeCloseTo(1 / 3);
  });

  it('stamps the catalog as the source on every sample', () => {
    for (const sample of catalogSamples([scaffolded], OBSERVED)) {
      expect(sample.source).toBe('catalog');
      expect(sample.observedAt).toBe(OBSERVED);
    }
  });
});

describe('collectCatalog', () => {
  const access = {
    baseUrl: async () => 'http://backstage:7007/api/catalog',
    token: async () => 'tok',
  };

  it('reports unavailable rather than 0% ownership for an empty catalog', async () => {
    mockFetchJson(() => []);
    const result = await collectCatalog(access);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/no Components/i);
  });

  it('reports unavailable when the catalog does not answer', async () => {
    mockFetchJson(() => undefined);
    const result = await collectCatalog(access);
    expect(result.unavailable?.source).toBe('catalog');
  });

  it('reports unavailable when credentials cannot be obtained', async () => {
    const result = await collectCatalog({
      baseUrl: async () => 'http://backstage:7007/api/catalog',
      token: async () => {
        throw new Error('no service credentials');
      },
    });
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/credentials/);
  });

  it('requests only the fields the signals need', async () => {
    const urls: string[] = [];
    mockFetchJson(url => {
      urls.push(url);
      return [{ kind: 'Component', metadata: { name: 'a' }, spec: { owner: 'x' } }];
    });
    await collectCatalog(access);
    const url = decodeURIComponent(urls[0]);
    expect(url).toContain('filter=kind=component');
    expect(url).toContain('spec.owner');
    expect(url).toContain('metadata.annotations');
  });
});

// ── tech insights ─────────────────────────────────────────────────────────────

describe('techInsightsSamples', () => {
  it('aggregates facts without recomputing any check', () => {
    // The scorecard is already implemented three times in this repo, with two
    // different gold thresholds. This collector consumes the retriever's output
    // and must never grow a fourth definition of a check.
    const samples = techInsightsSamples(
      [
        { 'has-owner': true, 'has-techdocs': false },
        { 'has-owner': true, 'has-techdocs': true },
      ],
      OBSERVED,
    );
    const ratio = samples.find(s => s.metric === 'scorecard.checksPassedRatio');
    expect(ratio?.value).toBe(0.75);
  });

  it('counts a missing fact as not-evaluated rather than as a failure', () => {
    const samples = techInsightsSamples(
      [{ 'has-sonar-scanning': true }, { 'has-owner': true }],
      OBSERVED,
    );
    // Only one entity was evaluated for a security check, and it passed.
    const security = samples.find(s => s.metric === 'security.scanningControlsRatio');
    expect(security?.value).toBe(1);
  });

  it('scores only literal true as a pass', () => {
    const samples = techInsightsSamples(
      [{ 'has-snyk-scanning': false }, { 'has-snyk-scanning': true }],
      OBSERVED,
    );
    expect(
      samples.find(s => s.metric === 'security.scanningControlsRatio')?.value,
    ).toBe(0.5);
  });

  it('produces the AI governance ratio from the three governance checks', () => {
    const samples = techInsightsSamples(
      [
        { 'has-model-card': true, 'has-eval-suite': false, 'has-ai-observability': true },
      ],
      OBSERVED,
    );
    expect(
      samples.find(s => s.metric === 'ai.governanceChecksRatio')?.value,
    ).toBeCloseTo(2 / 3);
  });

  it('produces nothing at all from an empty bundle list', () => {
    expect(techInsightsSamples([], OBSERVED)).toEqual([]);
  });
});

describe('collectTechInsights', () => {
  const access = {
    baseUrl: async () => 'http://backstage:7007/api/tech-insights',
    token: async () => 'tok',
    entityRefs: async () => ['component:default/a'],
  };

  it('reports unavailable before the retriever has produced any facts', async () => {
    // The retriever runs on a 30-minute cadence, so a freshly booted platform
    // legitimately has none. That is missing evidence, not a zero score.
    mockFetchJson(() => ({ 'idp-entity-facts': { facts: {} } }));
    const result = await collectTechInsights(access);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.source).toBe('techInsights');
  });

  it('reports unavailable when there are no components to ask about', async () => {
    const result = await collectTechInsights({ ...access, entityRefs: async () => [] });
    expect(result.unavailable?.reason).toMatch(/No Component entities/);
  });

  it('collects facts for every entity ref it is given', async () => {
    const urls: string[] = [];
    mockFetchJson(url => {
      urls.push(url);
      return { 'idp-entity-facts': { facts: { 'has-owner': true } } };
    });
    await collectTechInsights({
      ...access,
      entityRefs: async () => ['component:default/a', 'component:default/b'],
    });
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[0])).toContain('ids[]=idp-entity-facts');
  });
});

// ── opencost ──────────────────────────────────────────────────────────────────

describe('opencost efficiency', () => {
  it('accepts efficiency as a ratio and defensively as a percentage', () => {
    // OpenCost documents totalEfficiency as 0–1, but it has been observed
    // expressed as a percentage. Letting a 42 through would mean "4200%".
    expect(asRatio(0.42)).toBeCloseTo(0.42);
    expect(asRatio(42)).toBeCloseTo(0.42);
  });

  it('weights efficiency by cost so cheap namespaces cannot outvote the bill', () => {
    const efficiency = weightedEfficiency([
      {
        big: { totalCost: 100, totalEfficiency: 0.2 },
        tiny: { totalCost: 1, totalEfficiency: 1.0 },
      },
    ]);
    // A flat mean would give 0.6; cost weighting gives ~0.208.
    expect(efficiency).toBeCloseTo((0.2 * 100 + 1.0 * 1) / 101);
  });

  it('ignores zero-cost namespaces rather than skewing the mean', () => {
    const efficiency = weightedEfficiency([
      { paid: { totalCost: 10, totalEfficiency: 0.5 }, free: { totalCost: 0, totalEfficiency: 0 } },
    ]);
    expect(efficiency).toBeCloseTo(0.5);
  });

  it('returns undefined when nothing was priced', () => {
    expect(weightedEfficiency([{}])).toBeUndefined();
    expect(weightedEfficiency(undefined)).toBeUndefined();
  });
});

describe('collectOpenCost', () => {
  it('reports unavailable when OpenCost returns no priced allocations', async () => {
    mockFetchJson(() => ({ data: [{}] }));
    const result = await collectOpenCost(ctx);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.source).toBe('opencost');
  });

  it('emits the efficiency ratio when OpenCost answers', async () => {
    mockFetchJson(() => ({
      data: [{ services: { totalCost: 10, totalEfficiency: 0.62 } }],
    }));
    const result = await collectOpenCost(ctx);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].metric).toBe('finops.costEfficiencyRatio');
    expect(result.samples[0].value).toBeCloseTo(0.62);
    expect(result.samples[0].source).toBe('opencost');
  });
});

// ── langfuse ──────────────────────────────────────────────────────────────────

describe('langfuse rollup', () => {
  it('rolls per-day, per-model buckets up into one total', () => {
    const rolled = rollup({
      data: [
        {
          countTraces: 100,
          countObservations: 500,
          totalCost: 1.5,
          usage: [{ model: 'claude-opus-5' }, { model: 'gpt-4o' }],
        },
        {
          countTraces: 62,
          countObservations: 543,
          totalCost: 0.56,
          usage: [{ model: 'claude-opus-5' }],
        },
      ],
    });
    expect(rolled).toEqual({
      traces: 162,
      observations: 1043,
      costUsd: 2.06,
      models: 2,
    });
  });

  it('returns undefined when the API did not answer', () => {
    expect(rollup(undefined)).toBeUndefined();
    expect(rollup({})).toBeUndefined();
  });
});

describe('collectLangfuse', () => {
  it('reports unavailable without server-side credentials', async () => {
    // The frontend never holds these — the proxy injects them — so their absence
    // means "cannot observe", not "no traces".
    const noKeys = {
      config: new ConfigReader({
        proxy: { endpoints: { '/langfuse': { target: 'http://langfuse.idp.local' } } },
      }),
      logger: ctx.logger,
    };
    const result = await collectLangfuse(noKeys);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/publicKey|secretKey/);
  });

  it('reports observability active when traces are flowing', async () => {
    mockFetchJson(() => ({ data: [{ countTraces: 12, countObservations: 40, totalCost: 0.1 }] }));
    const result = await collectLangfuse(ctx);
    expect(result.samples[0].metric).toBe('ai.observabilityActive');
    expect(result.samples[0].value).toBe(1);
  });

  it('reports observability inactive — a real zero — when no traces arrived', async () => {
    // This is the one place a zero is a measurement rather than an absence:
    // Langfuse answered, and it has seen nothing.
    mockFetchJson(() => ({ data: [] }));
    const result = await collectLangfuse(ctx);
    expect(result.samples[0].value).toBe(0);
    expect(result.unavailable).toBeUndefined();
  });

  it('reports unavailable when Langfuse itself does not answer', async () => {
    mockFetchJson(() => undefined);
    const result = await collectLangfuse(ctx);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.source).toBe('langfuse');
  });

  it('does not put a per-service or per-team figure on the wire', async () => {
    // Langfuse traces here carry no catalog or team attribution, so any such
    // number would be a guess. Phase 8 adds the join key at the emitting end.
    mockFetchJson(() => ({ data: [{ countTraces: 5 }] }));
    const result = await collectLangfuse(ctx);
    expect(result.samples.map(s => s.metric)).toEqual(['ai.observabilityActive']);
  });
});
