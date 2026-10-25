// The Core 4 collectors join three sources — exporter counts, catalog
// membership and survey aggregates — and each join is a place a figure could
// quietly come to describe one person. These pin the floor at every join, and
// the same "no data, not zero" contract every other collector keeps.

import { ConfigReader } from '@backstage/config';
import { aggregateSurvey, DRIVERS, PERCEPTIONS, SurveyAnswers } from '@internal/engineering-intelligence-core';
import {
  CatalogRef,
  collectThroughput,
  prsByService,
  throughput,
} from '../engineeringIntelligence/throughput';
import {
  SurveyAggregateResponse,
  collectSurvey,
  surveySamples,
  teamInputs,
} from '../engineeringIntelligence/devexSurvey';

const NOW = '2026-10-17T12:00:00.000Z';

const group = (name: string, members: number): CatalogRef => ({
  metadata: { name },
  relations: Array.from({ length: members }, (_, i) => ({
    type: 'hasMember',
    targetRef: `user:default/${name}-${i}`,
  })),
});
const component = (name: string, owner: string): CatalogRef => ({
  metadata: { name },
  spec: { owner },
});

function survey(n: number, score = 4): SurveyAggregateResponse['org'] {
  const a: SurveyAnswers = {
    drivers: Object.fromEntries(DRIVERS.map(d => [d.id, score])) as SurveyAnswers['drivers'],
    perceptions: Object.fromEntries(PERCEPTIONS.map(p => [p.id, score])) as SurveyAnswers['perceptions'],
    time: { newCapabilities: 40, maintenance: 30, toil: 20, other: 10 },
  };
  return aggregateSurvey(Array(n).fill(a));
}

describe('prsByService', () => {
  it('reads one value per service label', () => {
    const prs = prsByService({
      data: {
        result: [
          { metric: { service: 'checkout' }, value: [0, '12'] },
          { metric: { service: 'search' }, value: [0, '3'] },
        ],
      },
    });
    expect([...prs!.entries()]).toEqual([['checkout', 12], ['search', 3]]);
  });

  it('is undefined for an empty vector, not an empty map', () => {
    expect(prsByService({ data: { result: [] } })).toBeUndefined();
    expect(prsByService(undefined)).toBeUndefined();
  });
});

describe('throughput', () => {
  const prs = new Map([
    ['checkout', 12],
    ['payments-api', 8],
    ['search', 6],
    ['orphan', 50],
  ]);
  const components = [
    component('checkout', 'group:default/payments'),
    component('payments-api', 'payments'),
    component('search', 'group:default/discovery'),
    component('orphan', 'group:default/ghosts'),
  ];

  it('divides merged PRs by distinct engineers across owning teams', () => {
    const groups = [group('payments', 5), group('discovery', 3), group('ghosts', 0)];
    const { samples, teams } = throughput(prs, components, groups, NOW);
    // (12 + 8 + 6) / 8 — the memberless team's 50 PRs have no denominator.
    expect(samples).toEqual([
      { metric: 'core4.diffsPerEngineerWeekly', value: 3.25, source: 'prometheus+catalog', observedAt: NOW },
    ]);
    expect(teams).toEqual([
      { team: 'payments', engineers: 5, mergedPrsWeekly: 20 },
      { team: 'discovery', engineers: 3, mergedPrsWeekly: 6 },
    ]);
  });

  it('counts someone in two teams once', () => {
    const shared = { type: 'hasMember', targetRef: 'user:default/shared' };
    const a = { ...group('payments', 4), relations: [...group('payments', 4).relations!, shared] };
    const b = { ...group('discovery', 0), relations: [shared] };
    const { samples } = throughput(prs, components, [a, b], NOW);
    expect(samples[0].value).toBe(Math.round((26 / 5) * 100) / 100);
  });

  it('emits no organisation figure below the floor', () => {
    const { samples } = throughput(prs, components, [group('payments', 2), group('discovery', 1)], NOW);
    expect(samples).toEqual([]);
  });
});

describe('collectThroughput', () => {
  const config = new ConfigReader({
    proxy: { endpoints: { '/prometheus': { target: 'http://prom.test' } } },
  });
  const ctx = { config, logger: { warn: jest.fn(), info: jest.fn() } };
  const catalog = { baseUrl: async () => 'http://catalog.test', token: async () => 't' };
  afterEach(() => jest.restoreAllMocks());

  it('reports the source unavailable, with no samples, before the exporter has the series', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { result: [] } }), { status: 200 }),
    );
    const result = await collectThroughput(ctx, catalog);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.source).toBe('throughput');
  });
});

describe('surveySamples', () => {
  const cycle = { id: 1, title: 'Q4', opensAt: NOW, closesAt: '2026-10-31T00:00:00.000Z', open: true };

  it('emits the five Core 4 survey metrics from an org aggregate', () => {
    const samples = surveySamples({ cycle, minResponses: 5, org: survey(6) }, NOW);
    expect(samples.map(s => s.metric)).toEqual([
      'survey.dxi',
      'survey.perceivedDeliveryRate',
      'survey.easeOfDelivery',
      'survey.perceivedQuality',
      'survey.newCapabilitiesRatio',
    ]);
    expect(samples[0]).toMatchObject({ value: 75, observedAt: NOW });
    expect(samples[4].value).toBe(0.4);
  });

  it('dates a closed cycle at its close, so its age is visible', () => {
    const closed = { ...cycle, open: false };
    const [first] = surveySamples({ cycle: closed, minResponses: 5, org: survey(6) }, NOW);
    expect(first.observedAt).toBe(closed.closesAt);
  });

  it('emits nothing while the organisation is below the floor', () => {
    expect(surveySamples({ cycle, minResponses: 5, org: survey(4) }, NOW)).toEqual([]);
  });
});

describe('collectSurvey', () => {
  const access = { baseUrl: async () => 'http://survey.test', token: async () => 't' };
  afterEach(() => jest.restoreAllMocks());

  it('reports no cycle as unavailable rather than as a zero score', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cycle: null, minResponses: 5 }), { status: 200 }),
    );
    const result = await collectSurvey(access);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.reason).toMatch(/No survey cycle/);
  });

  it('collapses a failing plugin to no samples', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const result = await collectSurvey(access);
    expect(result.samples).toEqual([]);
    expect(result.unavailable?.source).toBe('devex-survey');
  });
});

describe('teamInputs', () => {
  it('merges throughput and survey rows by team', () => {
    const merged = teamInputs([{ team: 'payments', engineers: 5, mergedPrsWeekly: 20 }], {
      cycle: null,
      minResponses: 5,
      teams: [
        { team: 'payments', ...survey(5)! },
        { team: 'unassigned', ...survey(2)! },
      ],
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ team: 'payments', engineers: 5, survey: { responses: 5 } });
    expect(merged[1]).toMatchObject({ team: 'unassigned', survey: { withheld: true } });
  });
});
