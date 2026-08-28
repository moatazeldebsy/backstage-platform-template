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
import {
  catalogSamples,
  collectCatalog,
  platformFacts,
} from '../engineeringIntelligence/catalog';
import {
  collectScaffolder,
  tallyTasks,
} from '../engineeringIntelligence/scaffolder';
import {
  collectLangfuse,
  langfuseAuth,
  promptFacts,
  rollup,
} from '../engineeringIntelligence/langfuse';
import {
  collectMlflow,
  registryFacts,
} from '../engineeringIntelligence/mlflow';
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

  it('withholds budget utilisation when no cost was attributed to any team', async () => {
    // The second instance of the same bug, found on the same real cluster. The
    // exporter publishes utilisation 0 for a team with no attributed spend, and
    // the inverse-linear normaliser reads 0 as perfectly under budget — scoring
    // 100 on a platform where no workload carries a `team` label.
    mockFetchJson(url => {
      const q = decodeURIComponent(url);
      if (q.includes('idp_team_budget_utilization_ratio')) {
        return vector([{ team: 'a' }, '0'], [{ team: 'b' }, '0']);
      }
      if (q.includes('idp_team_actual_cost_usd_monthly')) {
        return vector([{ team: 'a' }, '0'], [{ team: 'b' }, '0']);
      }
      if (q.includes('dora_')) return vector([{ service: 'a' }, '1']);
      return vector();
    });

    const result = await collectPrometheus(ctx);
    expect(result.samples.map(s => s.metric)).not.toContain(
      'finops.budgetUtilisationRatio',
    );
  });

  it('reports budget utilisation once real spend is attributed', async () => {
    mockFetchJson(url => {
      const q = decodeURIComponent(url);
      if (q.includes('idp_team_budget_utilization_ratio')) return vector([{ team: 'a' }, '0.82']);
      if (q.includes('idp_team_actual_cost_usd_monthly')) return vector([{ team: 'a' }, '412.50']);
      if (q.includes('dora_')) return vector([{ service: 'a' }, '1']);
      return vector();
    });

    const result = await collectPrometheus(ctx);
    const row = result.samples.find(s => s.metric === 'finops.budgetUtilisationRatio');
    expect(row?.value).toBeCloseTo(0.82);
  });

  it('withholds change failure rate and MTTR when nothing deployed', async () => {
    // Found on a real cluster, not by a test. The DORA exporter publishes 0.0
    // for a repo with no deployments rather than omitting the series, so a
    // platform that had never shipped reported CFR 0% and MTTR 0 minutes — which
    // the banded normalisers read as elite, scoring Reliability 100.
    //
    // Nothing failed and nothing was restored because nothing was deployed.
    mockFetchJson(url => {
      const q = decodeURIComponent(url);
      if (q.includes('dora_deploy_frequency_per_day')) {
        return vector([{ service: 'a' }, '0'], [{ service: 'b' }, '0']);
      }
      if (q.includes('dora_')) return vector([{ service: 'a' }, '0']);
      return vector();
    });

    const result = await collectPrometheus(ctx);
    const metrics = result.samples.map(s => s.metric);

    // Zero deploys per day is itself a real, reportable measurement.
    expect(metrics).toContain('dora.deployFrequencyPerDay');
    // These are not.
    expect(metrics).not.toContain('dora.changeFailureRatePercent');
    expect(metrics).not.toContain('dora.mttrMinutes');
    expect(metrics).not.toContain('dora.leadTimeMinutes');
  });

  it('reports change failure rate and MTTR once something has deployed', async () => {
    mockFetchJson(url => {
      const q = decodeURIComponent(url);
      if (q.includes('dora_deploy_frequency_per_day')) return vector([{ service: 'a' }, '1.5']);
      if (q.includes('dora_change_failure_rate_percent')) return vector([{ service: 'a' }, '4']);
      if (q.includes('dora_mttr_minutes')) return vector([{ service: 'a' }, '30']);
      if (q.includes('dora_lead_time_minutes')) return vector([{ service: 'a' }, '45']);
      return vector();
    });

    const result = await collectPrometheus(ctx);
    const byMetric = Object.fromEntries(result.samples.map(s => [s.metric, s.value]));
    expect(byMetric['dora.changeFailureRatePercent']).toBe(4);
    expect(byMetric['dora.mttrMinutes']).toBe(30);
    expect(byMetric['dora.leadTimeMinutes']).toBe(45);
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

// ── developer experience (phase 5) ────────────────────────────────────────────

describe('collectPrometheus — DevEx', () => {
  it('excludes the all-services roll-up from the devex queries too', async () => {
    // The exporter pushes a synthetic aggregate alongside the per-service rows,
    // exactly as it does for DORA. Forgetting the exclusion here would average
    // the aggregate in as if it were one more service.
    const urls: string[] = [];
    mockFetchJson(url => {
      urls.push(url);
      return vector([{ service: 'a' }, '1']);
    });
    await collectPrometheus(ctx);

    const devexUrls = urls
      .map(u => decodeURIComponent(u))
      .filter(u => u.includes('devex_'));
    expect(devexUrls).toHaveLength(3);
    for (const url of devexUrls) {
      expect(url).toContain('service!="all-services"');
    }
  });

  it('maps the three series the exporter publishes', async () => {
    mockFetchJson(url => {
      const q = decodeURIComponent(url);
      if (q.includes('devex_pr_cycle_time_hours')) return vector([{ service: 'a' }, '9']);
      if (q.includes('devex_ci_duration_minutes')) return vector([{ service: 'a' }, '12']);
      if (q.includes('devex_build_failure_ratio')) return vector([{ service: 'a' }, '0.08']);
      if (q.includes('dora_')) return vector([{ service: 'a' }, '1']);
      return vector();
    });

    const result = await collectPrometheus(ctx);
    const byMetric = Object.fromEntries(result.samples.map(s => [s.metric, s.value]));
    expect(byMetric['devex.prCycleTimeHours']).toBe(9);
    expect(byMetric['devex.ciDurationMinutes']).toBe(12);
    expect(byMetric['devex.buildFailureRatio']).toBeCloseTo(0.08);
  });

  it('omits a devex metric the exporter chose not to publish', async () => {
    // The exporter leaves a series out entirely when nothing merged or nothing
    // ran, rather than pushing 0.0. An empty vector must therefore stay absent
    // — a zero here would claim instant CI and a flawless build.
    mockFetchJson(url =>
      decodeURIComponent(url).includes('dora_')
        ? vector([{ service: 'a' }, '1'])
        : vector(),
    );
    const result = await collectPrometheus(ctx);
    const metrics = result.samples.map(s => s.metric);
    expect(metrics).not.toContain('devex.prCycleTimeHours');
    expect(metrics).not.toContain('devex.buildFailureRatio');
  });
});

// ── platform facts (phase 4) ──────────────────────────────────────────────────

describe('platformFacts', () => {
  const entities = [
    {
      kind: 'Component',
      metadata: {
        name: 'orders-api',
        annotations: { 'backstage.io/source-template': 'template:default/go-service' },
      },
      spec: { owner: 'team-payments' },
    },
    {
      kind: 'Component',
      metadata: {
        name: 'auth-service',
        annotations: { 'backstage.io/source-template': 'template:default/go-service' },
      },
      spec: { owner: 'team-platform' },
    },
    {
      kind: 'Component',
      metadata: {
        name: 'billing-ui',
        annotations: { 'backstage.io/source-template': 'template:default/react-app' },
      },
      spec: { owner: 'team-payments' },
    },
    { kind: 'Component', metadata: { name: 'legacy-cron' }, spec: { owner: 'team-data' } },
    { kind: 'Component', metadata: { name: 'adhoc-tool' }, spec: {} },
  ];

  it('counts services, owners and golden-path provenance', () => {
    const facts = platformFacts(entities);
    expect(facts.serviceCount).toBe(5);
    expect(facts.ownedCount).toBe(4);
    expect(facts.scaffoldedCount).toBe(3);
  });

  it('ranks template usage, most used first', () => {
    expect(platformFacts(entities).templateUsage).toEqual([
      { template: 'go-service', count: 2 },
      { template: 'react-app', count: 1 },
    ]);
  });

  it('names the services that are not on a golden path', () => {
    // The actionable half. "42 services are not on a golden path" is a
    // statistic; naming them is something a platform team can act on.
    expect(platformFacts(entities).unscaffolded).toEqual(['adhoc-tool', 'legacy-cron']);
  });

  it('sorts the named list so it does not reshuffle between refreshes', () => {
    const reversed = [...entities].reverse();
    expect(platformFacts(reversed).unscaffolded).toEqual(
      platformFacts(entities).unscaffolded,
    );
  });

  it('caps the named list rather than returning an unbounded catalog', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      kind: 'Component',
      metadata: { name: `svc-${String(i).padStart(3, '0')}` },
      spec: { owner: 'team' },
    }));
    const facts = platformFacts(many);
    expect(facts.serviceCount).toBe(120);
    expect(facts.unscaffolded).toHaveLength(50);
  });

  it('survives an empty catalog without dividing by zero', () => {
    const facts = platformFacts([]);
    expect(facts).toEqual({
      serviceCount: 0,
      ownedCount: 0,
      scaffoldedCount: 0,
      templateUsage: [],
      unscaffolded: [],
    });
  });
});

// ── scaffolder self-service (phase 4) ─────────────────────────────────────────

describe('tallyTasks', () => {
  it('separates finished tasks from those still running', () => {
    const outcome = tallyTasks([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'failed' },
      { status: 'processing' },
      { status: 'open' },
    ]);
    expect(outcome).toEqual({ completed: 2, failed: 1, inFlight: 2 });
  });

  it('counts a cancelled task as neither success nor failure', () => {
    // Someone changing their mind mid-run is not the scaffolder failing — the
    // same distinction build failure ratio draws against change failure rate.
    const outcome = tallyTasks([{ status: 'completed' }, { status: 'cancelled' }]);
    expect(outcome).toEqual({ completed: 1, failed: 0, inFlight: 0 });
  });
});

describe('collectScaffolder', () => {
  const access = {
    baseUrl: async () => 'http://backstage:7007/api/scaffolder',
    token: async () => 'tok',
  };

  it('reports the success ratio over finished tasks only', async () => {
    mockFetchJson(() => ({
      tasks: [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'completed' },
        { status: 'failed' },
        { status: 'processing' },
      ],
    }));
    const result = await collectScaffolder(access);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].metric).toBe('scaffolder.taskSuccessRatio');
    expect(result.samples[0].value).toBeCloseTo(0.75);
    expect(result.samples[0].source).toBe('scaffolder');
  });

  it('reports unavailable on a platform where nothing has been scaffolded', async () => {
    // 0% would say the scaffolder is broken; 100% would say it is proven.
    // Neither is true before anyone has used it.
    mockFetchJson(() => ({ tasks: [{ status: 'processing' }] }));
    const result = await collectScaffolder(access);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/cannot be measured/);
  });

  it('reads the task list over HTTP, not out of the scaffolder database', async () => {
    // The task rows live in another plugin's schema, which Backstage does not
    // treat as public. Reaching into it would couple this collector to a table
    // it does not own.
    const urls: string[] = [];
    mockFetchJson(url => {
      urls.push(url);
      return { tasks: [{ status: 'completed' }] };
    });
    await collectScaffolder(access);
    expect(urls[0]).toContain('/api/scaffolder/v2/tasks');
  });

  it('reports unavailable when the scaffolder does not answer', async () => {
    mockFetchJson(() => undefined);
    const result = await collectScaffolder(access);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.source).toBe('scaffolder');
  });
});

// ── model and prompt management (phase 6) ─────────────────────────────────────

describe('registryFacts', () => {
  it('counts a registered name with no versions as unmanaged', () => {
    // The registry equivalent of an empty repository: it shows intent, not
    // practice, and counting it as managed would flatter a platform where
    // somebody clicked "create" once.
    const facts = registryFacts([
      { name: 'churn', latest_versions: [{ version: '1', current_stage: 'Production' }] },
      { name: 'placeholder' },
      { name: 'empty', latest_versions: [] },
    ]);
    expect(facts).toEqual({ registered: 3, versioned: 1 });
  });
});

describe('collectMlflow', () => {
  const ctxWithMlflow = {
    config: new ConfigReader({
      proxy: { endpoints: { '/mlflow': { target: 'http://mlflow.idp.local' } } },
    }),
    logger: ctx.logger,
  };

  it('reports the versioned ratio over registered models', async () => {
    mockFetchJson(() => ({
      registered_models: [
        { name: 'a', latest_versions: [{ version: '1' }] },
        { name: 'b', latest_versions: [{ version: '3' }] },
        { name: 'c' },
      ],
    }));
    const result = await collectMlflow(ctxWithMlflow);
    const row = result.samples.find(s => s.metric === 'ai.modelVersionedRatio');
    expect(row?.value).toBeCloseTo(2 / 3);
    expect(row?.source).toBe('mlflow');
  });

  it('searches over POST, as the MLflow 2.x API requires', async () => {
    // The same trap the /mlflow proxy hit: search is POST, and a GET returns 405.
    const methods: (string | undefined)[] = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      methods.push(init?.method);
      return { ok: true, status: 200, json: async () => ({ registered_models: [] }) } as any;
    }) as any;
    await collectMlflow(ctxWithMlflow);
    expect(methods[0]).toBe('POST');
  });

  it('reports unavailable for an empty registry rather than scoring zero', async () => {
    // A platform with no models has nothing to manage. Scoring 0% would demand
    // model governance from a team that has not shipped a model.
    mockFetchJson(() => ({ registered_models: [] }));
    const result = await collectMlflow(ctxWithMlflow);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/No models are registered/);
  });

  it('reports unavailable when MLflow does not answer', async () => {
    mockFetchJson(() => undefined);
    const result = await collectMlflow(ctxWithMlflow);
    expect(result.unavailable?.source).toBe('mlflow');
  });
});

describe('promptFacts', () => {
  it('counts only prompts carrying the production label as managed', () => {
    // That label is what sync-agent-prompts.py pushes and what its drift check
    // compares against. A prompt uploaded once without it is a draft.
    expect(
      promptFacts({
        data: [
          { name: 'idp-agent', labels: ['production', 'latest'] },
          { name: 'draft-agent', labels: ['latest'] },
          { name: 'no-labels' },
        ],
      }),
    ).toEqual({ total: 3, managed: 1 });
  });

  it('returns undefined when Langfuse did not answer', () => {
    expect(promptFacts(undefined)).toBeUndefined();
    expect(promptFacts({})).toBeUndefined();
  });
});

describe('collectLangfuse — prompts', () => {
  it('emits prompt management alongside observability', async () => {
    mockFetchJson(url =>
      url.includes('/prompts')
        ? { data: [{ name: 'a', labels: ['production'] }, { name: 'b', labels: [] }] }
        : { data: [{ countTraces: 3 }] },
    );
    const result = await collectLangfuse(ctx);
    const byMetric = Object.fromEntries(result.samples.map(s => [s.metric, s.value]));
    expect(byMetric['ai.observabilityActive']).toBe(1);
    expect(byMetric['ai.promptsManagedRatio']).toBeCloseTo(0.5);
  });

  it('keeps the observability sample when the prompt call fails', async () => {
    // The two answer different questions; one being unavailable says nothing
    // about the other.
    mockFetchJson(url =>
      url.includes('/prompts') ? undefined : { data: [{ countTraces: 3 }] },
    );
    const result = await collectLangfuse(ctx);
    expect(result.samples.map(s => s.metric)).toEqual(['ai.observabilityActive']);
  });

  it('omits prompt management when there are no prompts at all', async () => {
    // No prompts is not bad prompt management — it is a platform with no prompts.
    mockFetchJson(url =>
      url.includes('/prompts') ? { data: [] } : { data: [{ countTraces: 3 }] },
    );
    const result = await collectLangfuse(ctx);
    expect(result.samples.map(s => s.metric)).not.toContain('ai.promptsManagedRatio');
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

  it('also emits the three governance facts separately, for the readiness model', () => {
    // Blended, they answer "how governed is AI overall". Apart, they say which
    // of model cards, eval suites and observability is actually missing.
    const samples = techInsightsSamples(
      [{ 'has-model-card': true, 'has-eval-suite': false, 'has-ai-observability': true }],
      OBSERVED,
    );
    const byMetric = Object.fromEntries(samples.map(s => [s.metric, s.value]));
    expect(byMetric['ai.modelCardRatio']).toBe(1);
    expect(byMetric['ai.evalSuiteRatio']).toBe(0);
    expect(byMetric['ai.observabilityWiredRatio']).toBe(1);
    // ...and the blended ratio the health model uses is unchanged.
    expect(byMetric['ai.governanceChecksRatio']).toBeCloseTo(2 / 3);
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

describe('langfuseAuth', () => {
  it('prefers an explicit key pair', () => {
    const auth = langfuseAuth(
      new ConfigReader({ langfuse: { publicKey: 'pk', secretKey: 'sk' } }),
    );
    expect(auth).toEqual({
      header: `Basic ${Buffer.from('pk:sk').toString('base64')}`,
    });
  });

  it('falls back to the credential already on the /langfuse proxy', () => {
    // The fix for a real mismatch: app-config.local.yaml supplies the project
    // key pair as one pre-encoded LANGFUSE_BASIC_AUTH value on the proxy, so
    // demanding a second copy under different names made the collector report
    // Langfuse unavailable on a cluster where it was demonstrably running.
    const auth = langfuseAuth(
      new ConfigReader({
        proxy: {
          endpoints: {
            '/langfuse': {
              target: 'http://langfuse.idp.local',
              headers: { Authorization: 'Basic cGs6c2s=' },
            },
          },
        },
      }),
    );
    expect(auth).toEqual({ header: 'Basic cGs6c2s=' });
  });

  it('recognises the not-configured placeholder as "never deployed"', () => {
    // Backstage needs *some* value there or the proxy fails to start, so the
    // placeholder's presence means Langfuse was never installed. Sending it
    // would earn a 401 and report the wrong reason entirely.
    const auth = langfuseAuth(
      new ConfigReader({
        proxy: {
          endpoints: {
            '/langfuse': {
              target: 'http://langfuse.idp.local',
              headers: { Authorization: 'Basic bm90LWNvbmZpZ3VyZWQ=' },
            },
          },
        },
      }),
    );
    expect(auth).toEqual({
      reason: expect.stringMatching(/not been deployed|not-configured/),
    });
  });

  it('reports no credential at all when the proxy carries none', () => {
    const auth = langfuseAuth(
      new ConfigReader({
        proxy: { endpoints: { '/langfuse': { target: 'http://langfuse.idp.local' } } },
      }),
    );
    expect(auth).toEqual({ reason: expect.stringMatching(/No Langfuse credential/) });
  });
});

describe('collectLangfuse', () => {
  it('reports unavailable without any credential', async () => {
    const noKeys = {
      config: new ConfigReader({
        proxy: { endpoints: { '/langfuse': { target: 'http://langfuse.idp.local' } } },
      }),
      logger: ctx.logger,
    };
    const result = await collectLangfuse(noKeys);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/No Langfuse credential/);
  });

  it('collects using only the proxy credential, with no langfuse.* keys set', async () => {
    mockFetchJson(() => ({ data: [{ countTraces: 4 }] }));
    const proxyOnly = {
      config: new ConfigReader({
        proxy: {
          endpoints: {
            '/langfuse': {
              target: 'http://langfuse.idp.local',
              headers: { Authorization: 'Basic cGs6c2s=' },
            },
          },
        },
      }),
      logger: ctx.logger,
    };
    const result = await collectLangfuse(proxyOnly);
    expect(result.unavailable).toBeUndefined();
    expect(result.samples[0].metric).toBe('ai.observabilityActive');
    expect(result.samples[0].value).toBe(1);
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
    //
    // Asserted as "no attributed metric" rather than an exact list: phase 6
    // legitimately added prompt management to this collector, and an exact-array
    // assertion would have failed for a correct change while still not checking
    // the thing the test is named for.
    mockFetchJson(() => ({ data: [{ countTraces: 5 }] }));
    const result = await collectLangfuse(ctx);

    for (const s of result.samples) {
      expect(s.metric).not.toMatch(/perService|perTeam|ByTeam|ByService/i);
      expect(s.labels?.team).toBeUndefined();
      expect(s.labels?.service).toBeUndefined();
    }
    expect(result.samples.map(s => s.metric)).toContain('ai.observabilityActive');
  });
});
